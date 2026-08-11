import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import packageJson from '../../package.json' with { type: 'json' }
import { runNpmServeSupervisor } from './npm-serve-supervisor'
import {
  NPM_SUPERVISOR_PROTOCOL_VERSION,
  type NpmUpdateActivationMessage,
  type NpmWorkerReadyMessage
} from './npm-supervisor-protocol'
import { readNpmSupervisorState } from './npm-supervisor-state'
import type { NpmSupervisedWorker } from './npm-supervised-worker'

const roots: string[] = []
const targetVersion = '1.4.179'

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('npm serve supervisor', () => {
  it('commits durably before publication and reports success only after readiness', async () => {
    const root = await createRoot()
    const initial = fakeWorker('/launcher/cli.js', packageJson.version, 'runtime-old')
    const candidate = fakeWorker('/candidate/cli.js', targetVersion, 'runtime-new', {
      deferPrepared: true,
      deferReady: true
    })
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(initial.worker)
      .mockReturnValueOnce(candidate.worker)
    const stopWorker = vi.fn(async () => undefined)
    const ipc = fakeSupervisorIpc()
    const run = runNpmServeSupervisor(serverArgs(root), {
      launcherEntry: '/launcher/cli.js',
      spawnWorker,
      stopWorker,
      ...ipc,
      verifyPinnedRuntime: async () => '/candidate/cli.js'
    })

    initial.activate(activation())
    await vi.waitFor(async () =>
      expect(await readNpmSupervisorState(root)).toMatchObject({
        pending: { targetVersion }
      })
    )
    expect(await readNpmSupervisorState(root)).not.toHaveProperty('activeVersion')
    candidate.markPrepared()
    await vi.waitFor(() => expect(ipc.commitWorker).toHaveBeenCalledWith(candidate.worker))
    expect(await readNpmSupervisorState(root)).toMatchObject({ activeVersion: targetVersion })
    expect(ipc.reportSuccess).not.toHaveBeenCalled()
    candidate.markReady()
    await vi.waitFor(() =>
      expect(ipc.reportSuccess).toHaveBeenCalledWith(candidate.worker, 'request-1')
    )
    const committed = await readNpmSupervisorState(root)
    expect(committed).not.toHaveProperty('pending')
    expect(committed).not.toHaveProperty('failure')
    candidate.exit({ code: 0, signal: null })

    await expect(run).resolves.toBe(0)
    expect(stopWorker).toHaveBeenCalledWith(initial.worker, 'SIGTERM')
    expect(spawnWorker).toHaveBeenNthCalledWith(2, '/candidate/cli.js', serverArgs(root))
  })

  it('rolls back and preserves the originating failure when a candidate is not ready', async () => {
    const root = await createRoot()
    const initial = fakeWorker('/launcher/cli.js', packageJson.version, 'runtime-old')
    const candidate = fakeWorker('/candidate/cli.js', targetVersion, 'runtime-candidate')
    const rollback = fakeWorker('/launcher/cli.js', packageJson.version, 'runtime-rollback')
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(initial.worker)
      .mockReturnValueOnce(candidate.worker)
      .mockReturnValueOnce(rollback.worker)
    const waitForReady = vi.fn(async (worker: NpmSupervisedWorker, expectedVersion: string) => {
      if (expectedVersion === targetVersion) {
        throw new Error('npm_update_worker_ready_timeout')
      }
      return worker.ready
    })
    const ipc = fakeSupervisorIpc()
    const run = runNpmServeSupervisor(serverArgs(root), {
      launcherEntry: '/launcher/cli.js',
      spawnWorker,
      stopWorker: async () => undefined,
      ...ipc,
      verifyPinnedRuntime: async () => '/candidate/cli.js',
      waitForReady
    })

    initial.activate(activation())
    await vi.waitFor(async () =>
      expect(await readNpmSupervisorState(root)).toMatchObject({
        failure: {
          requestId: 'request-1',
          targetVersion,
          originRuntimeId: 'runtime-old',
          reason: 'npm_update_worker_ready_timeout'
        }
      })
    )
    rollback.exit({ code: 0, signal: null })

    await expect(run).resolves.toBe(0)
    expect(spawnWorker).toHaveBeenNthCalledWith(3, '/launcher/cli.js', serverArgs(root))
  })

  it('ignores stale and duplicate activation messages', async () => {
    const root = await createRoot()
    const initial = fakeWorker('/launcher/cli.js', packageJson.version, 'runtime-old')
    const candidate = fakeWorker('/candidate/cli.js', targetVersion, 'runtime-new')
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(initial.worker)
      .mockReturnValueOnce(candidate.worker)
    const ipc = fakeSupervisorIpc()
    const run = runNpmServeSupervisor(serverArgs(root), {
      launcherEntry: '/launcher/cli.js',
      spawnWorker,
      stopWorker: vi.fn(async () => undefined),
      ...ipc,
      verifyPinnedRuntime: async () => '/candidate/cli.js'
    })

    initial.activate({ ...activation(), runtimeId: 'stale-runtime' })
    await vi.waitFor(() =>
      expect(ipc.reportFailure).toHaveBeenCalledWith(
        initial.worker,
        expect.objectContaining({ reason: 'npm_update_stale_runtime' })
      )
    )
    initial.activate(activation())
    initial.activate(activation())
    await vi.waitFor(async () =>
      expect(await readNpmSupervisorState(root)).toMatchObject({ activeVersion: targetVersion })
    )
    candidate.exit({ code: 0, signal: null })

    await expect(run).resolves.toBe(0)
    expect(spawnWorker).toHaveBeenCalledTimes(2)
  })

  it('keeps the healthy worker running when pending state cannot be written', async () => {
    const root = await createRoot()
    const initial = fakeWorker('/launcher/cli.js', packageJson.version, 'runtime-old')
    const stopWorker = vi.fn(async () => undefined)
    const ipc = fakeSupervisorIpc()
    ipc.reportFailure.mockRejectedValue(new Error('ipc unavailable'))
    const run = runNpmServeSupervisor(serverArgs(root), {
      launcherEntry: '/launcher/cli.js',
      spawnWorker: vi.fn(() => initial.worker),
      stopWorker,
      ...ipc,
      beginHandoff: async () => {
        throw new Error('disk unavailable')
      },
      verifyPinnedRuntime: async () => '/candidate/cli.js'
    })

    initial.activate(activation())
    await vi.waitFor(() => expect(ipc.reportFailure).toHaveBeenCalledOnce())
    expect(stopWorker).not.toHaveBeenCalled()
    initial.exit({ code: 0, signal: null })

    await expect(run).resolves.toBe(0)
  })

  it('reports failed activation preflight without stopping the healthy worker', async () => {
    const root = await createRoot()
    const initial = fakeWorker('/launcher/cli.js', packageJson.version, 'runtime-old')
    const stopWorker = vi.fn(async () => undefined)
    const ipc = fakeSupervisorIpc()
    const spawnWorker = vi.fn(() => initial.worker)
    const run = runNpmServeSupervisor(serverArgs(root), {
      launcherEntry: '/launcher/cli.js',
      spawnWorker,
      stopWorker,
      ...ipc,
      preflightPinnedRuntime: async () => {
        throw new Error('npm_update_native_load_failed')
      }
    })

    initial.activate(activation())
    await vi.waitFor(() =>
      expect(ipc.reportFailure).toHaveBeenCalledWith(
        initial.worker,
        expect.objectContaining({ reason: 'npm_update_native_load_failed' })
      )
    )
    expect(stopWorker).not.toHaveBeenCalled()
    expect(spawnWorker).toHaveBeenCalledOnce()
    initial.exit({ code: 0, signal: null })

    await expect(run).resolves.toBe(0)
  })

  it('restores the previous worker when durable candidate selection fails', async () => {
    const root = await createRoot()
    const initial = fakeWorker('/launcher/cli.js', packageJson.version, 'runtime-old')
    const candidate = fakeWorker('/candidate/cli.js', targetVersion, 'runtime-candidate')
    const rollback = fakeWorker('/launcher/cli.js', packageJson.version, 'runtime-rollback')
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(initial.worker)
      .mockReturnValueOnce(candidate.worker)
      .mockReturnValueOnce(rollback.worker)
    const run = runNpmServeSupervisor(serverArgs(root), {
      launcherEntry: '/launcher/cli.js',
      spawnWorker,
      stopWorker: vi.fn(async () => undefined),
      ...fakeSupervisorIpc(),
      commitCandidate: async () => {
        throw new Error('npm_update_state_write_failed')
      },
      verifyPinnedRuntime: async () => '/candidate/cli.js'
    })

    initial.activate(activation())
    await vi.waitFor(() => expect(spawnWorker).toHaveBeenCalledTimes(3))
    expect(await readNpmSupervisorState(root)).toMatchObject({
      failure: { reason: 'npm_update_state_write_failed' }
    })
    rollback.exit({ code: 0, signal: null })

    await expect(run).resolves.toBe(0)
  })
})

function activation(): NpmUpdateActivationMessage {
  return {
    type: 'orca:npm-update-activate',
    protocolVersion: NPM_SUPERVISOR_PROTOCOL_VERSION,
    requestId: 'request-1',
    fromVersion: packageJson.version,
    targetVersion,
    runtimeId: 'runtime-old'
  }
}

function fakeWorker(
  entryPath: string,
  version: string,
  runtimeId: string,
  options: { deferPrepared?: boolean; deferReady?: boolean } = {}
): {
  worker: NpmSupervisedWorker
  activate: (message: NpmUpdateActivationMessage) => void
  markReady: () => void
  markPrepared: () => void
  exit: (result: { code: number | null; signal: NodeJS.Signals | null }) => void
} {
  const activation = asyncQueue<NpmUpdateActivationMessage>()
  const exit = deferred<{ code: number | null; signal: NodeJS.Signals | null }>()
  const ready: NpmWorkerReadyMessage = {
    type: 'orca:npm-worker-ready',
    protocolVersion: NPM_SUPERVISOR_PROTOCOL_VERSION,
    version,
    runtimeId
  }
  const prepared = { ...ready, type: 'orca:npm-worker-prepared' as const }
  const preparedDeferred = deferred<typeof prepared>()
  const readyDeferred = deferred<NpmWorkerReadyMessage>()
  if (!options.deferPrepared) {
    preparedDeferred.resolve(prepared)
  }
  if (!options.deferReady) {
    readyDeferred.resolve(ready)
  }
  const child = {
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true)
  } as unknown as ChildProcess
  return {
    worker: {
      child,
      entryPath,
      prepared: preparedDeferred.promise,
      ready: readyDeferred.promise,
      protocolMismatch: new Promise(() => undefined),
      commitApplied: Promise.resolve(),
      nextFailureApplied: () => new Promise(() => undefined),
      nextSuccessApplied: () => new Promise(() => undefined),
      nextActivation: activation.take,
      exit: exit.promise
    },
    activate: activation.push,
    markPrepared: () => preparedDeferred.resolve(prepared),
    markReady: () => readyDeferred.resolve(ready),
    exit: exit.resolve
  }
}

function fakeSupervisorIpc() {
  return {
    waitForPrepared: async (worker: NpmSupervisedWorker) => worker.prepared,
    waitForReady: async (worker: NpmSupervisedWorker) => worker.ready,
    commitWorker: vi.fn(async () => undefined),
    reportFailure: vi.fn(async () => undefined),
    reportSuccess: vi.fn(async () => undefined)
  }
}

function asyncQueue<T>(): { push: (value: T) => void; take: () => Promise<T> } {
  const values: T[] = []
  const waiters: ((value: T) => void)[] = []
  return {
    push: (value) => {
      const waiter = waiters.shift()
      if (waiter) {
        waiter(value)
      } else {
        values.push(value)
      }
    },
    take: () => {
      const value = values.shift()
      return value === undefined
        ? new Promise<T>((resolve) => waiters.push(resolve))
        : Promise.resolve(value)
    }
  }
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-npm-supervisor-'))
  roots.push(root)
  return root
}

function serverArgs(dataPath: string): string[] {
  return ['serve', '--data-dir', dataPath, '--port', '0', '--json']
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}
