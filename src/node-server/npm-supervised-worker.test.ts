import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  spawnNpmSupervisedWorker,
  stopNpmSupervisedWorker,
  waitForNpmWorkerPrepared,
  waitForNpmWorkerReady,
  type NpmSupervisedWorker
} from './npm-supervised-worker'
import {
  NPM_SUPERVISOR_PROTOCOL_VERSION,
  type NpmUpdateActivationMessage,
  type NpmWorkerReadyMessage
} from './npm-supervisor-protocol'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('npm supervised worker', () => {
  it('rejects candidate readiness for the wrong exact version', async () => {
    const worker = fakeWorker(Promise.resolve(ready('1.5.1')), new Promise(() => undefined))

    await expect(waitForNpmWorkerReady(worker, '1.5.0')).rejects.toThrow(
      'npm_update_worker_version_mismatch'
    )
  })

  it('rejects when the candidate exits before readiness', async () => {
    const worker = fakeWorker(
      new Promise(() => undefined),
      Promise.resolve({ code: 1, signal: null })
    )

    await expect(waitForNpmWorkerReady(worker, '1.5.0')).rejects.toThrow(
      'npm_update_worker_exited_before_ready'
    )
  })

  it('shares protocol mismatch failure without an unhandled phase rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-protocol-mismatch-'))
    roots.push(root)
    const entryPath = join(root, 'worker.cjs')
    await writeFile(
      entryPath,
      `process.on('message', (message) => {
  if (message?.type === 'orca:npm-worker-stop') process.exit(0)
})
process.send?.({
  type: 'orca:npm-worker-prepared',
  protocolVersion: 999,
  version: '1.5.0',
  runtimeId: 'runtime-id'
})
`
    )
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    const worker = spawnNpmSupervisedWorker(entryPath, [])
    try {
      await expect(waitForNpmWorkerPrepared(worker, '1.5.0')).rejects.toThrow(
        'npm_update_worker_protocol_mismatch'
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await stopNpmSupervisedWorker(worker, 'SIGTERM')
    }
  })

  it('escalates a worker that does not stop and clears the timeout', async () => {
    vi.useFakeTimers()
    const exited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>()
    const kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === 'SIGKILL') {
        exited.resolve({ code: null, signal })
      }
      return true
    })
    const worker = fakeWorker(Promise.resolve(ready('1.5.0')), exited.promise, kill)

    const stopping = stopNpmSupervisedWorker(worker, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(35_000)
    await stopping

    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('requests joined shutdown over IPC before using an OS signal', async () => {
    const exited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>()
    const send = vi.fn(() => {
      exited.resolve({ code: 0, signal: null })
      return true
    })
    const kill = vi.fn(() => true)
    const worker = fakeWorker(Promise.resolve(ready('1.5.0')), exited.promise, kill, send)

    await stopNpmSupervisedWorker(worker, 'SIGTERM')

    expect(send).toHaveBeenCalledWith(
      {
        type: 'orca:npm-worker-stop',
        protocolVersion: NPM_SUPERVISOR_PROTOCOL_VERSION,
        signal: 'SIGTERM'
      },
      expect.any(Function)
    )
    expect(kill).not.toHaveBeenCalled()
  })

  it('uses an OS signal when the graceful stop message is not delivered', async () => {
    const exited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>()
    const kill = vi.fn((signal: NodeJS.Signals) => {
      exited.resolve({ code: null, signal })
      return true
    })
    const send = vi.fn((_message: unknown, callback: (error: Error | null) => void) => {
      callback(new Error('ipc closed'))
      return false
    })
    const worker = fakeWorker(Promise.resolve(ready('1.5.0')), exited.promise, kill, send)

    await stopNpmSupervisedWorker(worker, 'SIGTERM')

    expect(kill).toHaveBeenCalledWith('SIGTERM')
  })
})

function fakeWorker(
  readyPromise: Promise<NpmWorkerReadyMessage>,
  exit: NpmSupervisedWorker['exit'],
  kill: (signal: NodeJS.Signals) => boolean = vi.fn(() => true),
  send?: (message: unknown, callback: (error: Error | null) => void) => boolean
): NpmSupervisedWorker {
  return {
    child: {
      exitCode: null,
      signalCode: null,
      kill,
      connected: send !== undefined,
      send
    } as unknown as ChildProcess,
    entryPath: '/runtime/cli.js',
    prepared: Promise.resolve({ ...ready('1.5.0'), type: 'orca:npm-worker-prepared' }),
    ready: readyPromise,
    protocolMismatch: new Promise(() => undefined),
    commitApplied: Promise.resolve(),
    nextFailureApplied: () => new Promise(() => undefined),
    nextSuccessApplied: () => new Promise(() => undefined),
    nextActivation: () => new Promise<NpmUpdateActivationMessage>(() => undefined),
    exit
  }
}

function ready(version: string): NpmWorkerReadyMessage {
  return {
    type: 'orca:npm-worker-ready',
    protocolVersion: NPM_SUPERVISOR_PROTOCOL_VERSION,
    version,
    runtimeId: 'runtime-id'
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}
