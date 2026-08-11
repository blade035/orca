import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  commitNpmCandidateWhileAlive,
  rollbackNpmHandoffWorker,
  startInitialNpmWorker
} from './npm-supervisor-worker-transition'
import {
  NPM_SUPERVISOR_PROTOCOL_VERSION,
  type NpmUpdateActivationMessage,
  type NpmWorkerReadyMessage
} from './npm-supervisor-protocol'
import {
  failNpmHandoff,
  readNpmSupervisorState,
  writeNpmSupervisorState
} from './npm-supervisor-state'
import type { NpmSupervisedWorker } from './npm-supervised-worker'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('npm supervisor worker transitions', () => {
  it('clears a broken pinned selection and starts the launcher fallback', async () => {
    const root = await createRoot()
    const state = { schemaVersion: 1 as const, activeVersion: '1.5.0' }
    await writeNpmSupervisorState(root, state)
    const pinned = fakeWorker('/pinned/cli.js', rejectedReady('protocol_mismatch'))
    const launcher = fakeWorker('/launcher/cli.js', Promise.resolve(ready('1.4.0', 'launcher')))
    const spawnWorker = vi.fn().mockReturnValueOnce(pinned).mockReturnValueOnce(launcher)

    const result = await startInitialNpmWorker(
      {
        entryPath: pinned.entryPath,
        version: '1.5.0',
        fallback: { entryPath: launcher.entryPath, version: '1.4.0' }
      },
      ['serve'],
      state,
      root,
      {
        ...fakeLifecycle(spawnWorker),
        onSpawn: () => undefined
      }
    )

    expect(result).toMatchObject({ running: { worker: launcher } })
    expect(await readNpmSupervisorState(root)).not.toHaveProperty('activeVersion')
    expect(spawnWorker).toHaveBeenCalledTimes(2)
  })

  it('does not mutate state when a duplicate worker reports profile ownership', async () => {
    const root = await createRoot()
    const state = { schemaVersion: 1 as const, activeVersion: '1.5.0' }
    await writeNpmSupervisorState(root, state)
    const duplicate = fakeWorker(
      '/pinned/cli.js',
      rejectedReady('npm_update_worker_exited_before_ready'),
      Promise.resolve({ code: 3, signal: null })
    )
    const spawnWorker = vi.fn(() => duplicate)

    const result = await startInitialNpmWorker(
      {
        entryPath: duplicate.entryPath,
        version: '1.5.0',
        fallback: { entryPath: '/launcher/cli.js', version: '1.4.0' }
      },
      ['serve'],
      state,
      root,
      {
        ...fakeLifecycle(spawnWorker),
        onSpawn: () => undefined
      }
    )

    expect(result).toEqual({ exitCode: 3 })
    expect(await readNpmSupervisorState(root)).toEqual(state)
    expect(spawnWorker).toHaveBeenCalledOnce()
  })

  it('stops a rollback worker when its readiness fails', async () => {
    const root = await createRoot()
    const rollback = fakeWorker('/launcher/cli.js', rejectedReady('rollback_not_ready'))
    const stopWorker = vi.fn(async () => undefined)

    await expect(
      rollbackNpmHandoffWorker(
        root,
        { schemaVersion: 1 },
        activation(),
        { entryPath: rollback.entryPath, version: '1.4.0' },
        ['serve'],
        {
          ...fakeLifecycle(() => rollback),
          stopWorker
        },
        () => undefined,
        'candidate_failed'
      )
    ).rejects.toThrow('rollback_not_ready')
    expect(stopWorker).toHaveBeenCalledWith(rollback, 'SIGTERM')
  })

  it('repairs transient rollback persistence after the previous worker is ready', async () => {
    const root = await createRoot()
    await writeNpmSupervisorState(root, { schemaVersion: 1, activeVersion: '1.5.0' })
    const readyDeferred = deferred<NpmWorkerReadyMessage>()
    const rollback = fakeWorker('/launcher/cli.js', readyDeferred.promise)
    const state = {
      schemaVersion: 1 as const,
      pending: {
        requestId: 'request-1',
        fromVersion: '1.4.0',
        targetVersion: '1.5.0',
        originRuntimeId: 'runtime-old'
      }
    }
    const persistFailure = vi
      .fn<typeof failNpmHandoff>()
      .mockRejectedValueOnce(new Error('disk temporarily unavailable'))
      .mockImplementation(failNpmHandoff)
    const rollbackPromise = rollbackNpmHandoffWorker(
      root,
      state,
      activation(),
      { entryPath: rollback.entryPath, version: '1.4.0' },
      ['serve'],
      {
        ...fakeLifecycle(() => rollback),
        failHandoff: persistFailure
      },
      () => undefined,
      'candidate_failed'
    )

    await vi.waitFor(() => expect(persistFailure).toHaveBeenCalledOnce())
    expect(await readNpmSupervisorState(root)).toMatchObject({ activeVersion: '1.5.0' })
    readyDeferred.resolve(ready('1.4.0', 'rollback'))
    const result = await rollbackPromise

    expect(persistFailure).toHaveBeenCalledTimes(2)
    expect(result?.state).toMatchObject({ failure: { reason: 'candidate_failed' } })
    const repaired = await readNpmSupervisorState(root)
    expect(repaired).not.toHaveProperty('activeVersion')
    expect(repaired).toMatchObject({ failure: { reason: 'candidate_failed' } })
  })

  it('rejects a candidate that exits while its selection is committing', async () => {
    const root = await createRoot()
    const candidate = fakeWorker(
      '/candidate/cli.js',
      Promise.resolve(ready('1.5.0', 'candidate')),
      Promise.resolve({ code: 1, signal: null })
    )

    await expect(
      commitNpmCandidateWhileAlive(root, { schemaVersion: 1 }, activation(), candidate)
    ).rejects.toThrow('npm_update_worker_exited_during_commit')
  })
})

function fakeWorker(
  entryPath: string,
  readyPromise: Promise<NpmWorkerReadyMessage>,
  exit: NpmSupervisedWorker['exit'] = new Promise(() => undefined)
): NpmSupervisedWorker {
  return {
    child: {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true)
    } as unknown as ChildProcess,
    entryPath,
    prepared: Promise.resolve({ ...ready('1.4.0', 'prepared'), type: 'orca:npm-worker-prepared' }),
    ready: readyPromise,
    protocolMismatch: new Promise(() => undefined),
    commitApplied: Promise.resolve(),
    nextFailureApplied: () => new Promise(() => undefined),
    nextSuccessApplied: () => new Promise(() => undefined),
    nextActivation: () => new Promise(() => undefined),
    exit
  }
}

function fakeLifecycle(spawnWorker: () => NpmSupervisedWorker) {
  return {
    spawnWorker,
    stopWorker: vi.fn(async () => undefined),
    commitWorker: vi.fn(async () => undefined),
    reportFailure: vi.fn(async () => undefined),
    waitForPrepared: async (worker: NpmSupervisedWorker) => worker.prepared,
    waitForReady: async (worker: NpmSupervisedWorker) => worker.ready,
    getStoppingSignal: () => null
  }
}

function ready(version: string, runtimeId: string): NpmWorkerReadyMessage {
  return {
    type: 'orca:npm-worker-ready',
    protocolVersion: NPM_SUPERVISOR_PROTOCOL_VERSION,
    version,
    runtimeId
  }
}

function activation(): NpmUpdateActivationMessage {
  return {
    type: 'orca:npm-update-activate',
    protocolVersion: NPM_SUPERVISOR_PROTOCOL_VERSION,
    requestId: 'request-1',
    fromVersion: '1.4.0',
    targetVersion: '1.5.0',
    runtimeId: 'runtime-old'
  }
}

function rejectedReady(message: string): Promise<NpmWorkerReadyMessage> {
  const promise = Promise.reject<NpmWorkerReadyMessage>(new Error(message))
  void promise.catch(() => undefined)
  return promise
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-npm-transition-'))
  roots.push(root)
  return root
}
