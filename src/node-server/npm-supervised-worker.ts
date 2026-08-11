import { spawn, type ChildProcess } from 'node:child_process'
import {
  NPM_SUPERVISOR_PROTOCOL_VERSION,
  NPM_WORKER_COMMAND,
  isNpmWorkerReadyProtocolMismatch,
  parseNpmSupervisorMessage,
  type NpmUpdateActivationMessage,
  type NpmUpdateFailureMessage,
  type NpmWorkerPreparedMessage,
  type NpmWorkerReadyMessage
} from './npm-supervisor-protocol'

const WORKER_READY_TIMEOUT_MS = 60_000
const WORKER_STOP_TIMEOUT_MS = 35_000
const stopPromises = new WeakMap<ChildProcess, Promise<void>>()

type WorkerExit = { code: number | null; signal: NodeJS.Signals | null }

export type NpmSupervisedWorker = {
  child: ChildProcess
  entryPath: string
  prepared: Promise<NpmWorkerPreparedMessage>
  ready: Promise<NpmWorkerReadyMessage>
  protocolMismatch: Promise<void>
  commitApplied: Promise<void>
  nextFailureApplied: () => Promise<string>
  nextSuccessApplied: () => Promise<string>
  nextActivation: () => Promise<NpmUpdateActivationMessage>
  exit: Promise<WorkerExit>
}

export function spawnNpmSupervisedWorker(entryPath: string, argv: string[]): NpmSupervisedWorker {
  const child = spawn(process.execPath, [entryPath, NPM_WORKER_COMMAND, ...argv], {
    env: { ...process.env, ORCA_NPM_SUPERVISED: '1' },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    windowsHide: true
  })
  const preparedDeferred = deferred<NpmWorkerPreparedMessage>()
  const readyDeferred = deferred<NpmWorkerReadyMessage>()
  const protocolMismatchDeferred = deferred<void>()
  const commitAppliedDeferred = deferred<void>()
  const activationQueue = asyncQueue<NpmUpdateActivationMessage>()
  const failureAppliedQueue = asyncQueue<string>()
  const successAppliedQueue = asyncQueue<string>()
  child.on('message', (value) => {
    const message = parseNpmSupervisorMessage(value)
    if (message?.type === 'orca:npm-worker-prepared') {
      preparedDeferred.resolve(message)
    } else if (message?.type === 'orca:npm-worker-ready') {
      readyDeferred.resolve(message)
    } else if (message?.type === 'orca:npm-update-activate') {
      activationQueue.push(message)
    } else if (message?.type === 'orca:npm-worker-commit-applied') {
      commitAppliedDeferred.resolve()
    } else if (message?.type === 'orca:npm-update-failure-applied') {
      failureAppliedQueue.push(message.requestId)
    } else if (message?.type === 'orca:npm-update-success-applied') {
      successAppliedQueue.push(message.requestId)
    } else if (isNpmWorkerReadyProtocolMismatch(value)) {
      protocolMismatchDeferred.resolve()
    }
  })
  const exit = new Promise<WorkerExit>((resolve) => {
    const onError = (): void => {
      if (child.pid === undefined) {
        settle({ code: 1, signal: null })
      }
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      settle({ code, signal })
    const settle = (result: WorkerExit): void => {
      child.off('error', onError)
      child.off('exit', onExit)
      resolve(result)
    }
    child.on('error', onError)
    child.once('exit', onExit)
  })
  return {
    child,
    entryPath,
    prepared: preparedDeferred.promise,
    ready: readyDeferred.promise,
    protocolMismatch: protocolMismatchDeferred.promise,
    commitApplied: commitAppliedDeferred.promise,
    nextFailureApplied: failureAppliedQueue.take,
    nextSuccessApplied: successAppliedQueue.take,
    nextActivation: activationQueue.take,
    exit
  }
}

export async function waitForNpmWorkerPrepared(
  worker: NpmSupervisedWorker,
  expectedVersion: string
): Promise<NpmWorkerPreparedMessage> {
  return waitForWorkerPhase(worker, worker.prepared, expectedVersion)
}

export async function waitForNpmWorkerReady(
  worker: NpmSupervisedWorker,
  expectedVersion: string
): Promise<NpmWorkerReadyMessage> {
  return waitForWorkerPhase(worker, worker.ready, expectedVersion)
}

async function waitForWorkerPhase<T extends NpmWorkerPreparedMessage | NpmWorkerReadyMessage>(
  worker: NpmSupervisedWorker,
  phase: Promise<T>,
  expectedVersion: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  const ready = await Promise.race([
    phase,
    worker.protocolMismatch.then(() => {
      throw new Error('npm_update_worker_protocol_mismatch')
    }),
    worker.exit.then(() => {
      throw new Error('npm_update_worker_exited_before_ready')
    }),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('npm_update_worker_ready_timeout')),
        WORKER_READY_TIMEOUT_MS
      )
    })
  ]).finally(() => {
    if (timeout) {
      clearTimeout(timeout)
    }
  })
  if (ready.version !== expectedVersion) {
    throw new Error('npm_update_worker_version_mismatch')
  }
  return ready
}

export async function commitNpmSupervisedWorker(worker: NpmSupervisedWorker): Promise<void> {
  await sendWorkerMessage(worker.child, {
    type: 'orca:npm-worker-commit',
    protocolVersion: NPM_SUPERVISOR_PROTOCOL_VERSION
  })
  await waitForWorkerAcknowledgement(worker, worker.commitApplied)
}

export async function reportNpmActivationFailure(
  worker: NpmSupervisedWorker,
  failure: Omit<NpmUpdateFailureMessage, 'type' | 'protocolVersion'>
): Promise<void> {
  await sendWorkerMessage(worker.child, {
    type: 'orca:npm-update-failed',
    protocolVersion: NPM_SUPERVISOR_PROTOCOL_VERSION,
    ...failure
  })
  await waitForWorkerAcknowledgement(
    worker,
    waitForRequestId(worker.nextFailureApplied, failure.requestId)
  )
}

export async function reportNpmActivationSuccess(
  worker: NpmSupervisedWorker,
  requestId: string
): Promise<void> {
  await sendWorkerMessage(worker.child, {
    type: 'orca:npm-update-committed',
    protocolVersion: NPM_SUPERVISOR_PROTOCOL_VERSION,
    requestId
  })
  await waitForWorkerAcknowledgement(worker, waitForRequestId(worker.nextSuccessApplied, requestId))
}

async function waitForRequestId(next: () => Promise<string>, requestId: string): Promise<void> {
  while ((await next()) !== requestId) {
    // Ignore acknowledgements from an obsolete request on the same worker.
  }
}

async function waitForWorkerAcknowledgement(
  worker: NpmSupervisedWorker,
  acknowledgement: Promise<void>
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  await Promise.race([
    acknowledgement,
    worker.exit.then(() => {
      throw new Error('npm_update_worker_exited_before_acknowledgement')
    }),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('npm_update_worker_acknowledgement_timeout')),
        WORKER_READY_TIMEOUT_MS
      )
    })
  ]).finally(() => {
    if (timeout) {
      clearTimeout(timeout)
    }
  })
}

function sendWorkerMessage(child: ChildProcess, message: object): Promise<void> {
  if (!child.connected || !child.send) {
    return Promise.reject(new Error('npm_update_worker_ipc_unavailable'))
  }
  return new Promise((resolve, reject) => {
    try {
      child.send!(message, (error) => (error ? reject(error) : resolve()))
    } catch (error) {
      reject(error)
    }
  })
}

export async function stopNpmSupervisedWorker(
  worker: NpmSupervisedWorker,
  signal: NodeJS.Signals
): Promise<void> {
  const existing = stopPromises.get(worker.child)
  if (existing) {
    return existing
  }
  const stopping = stopNpmSupervisedWorkerOnce(worker, signal)
  stopPromises.set(worker.child, stopping)
  return stopping
}

async function stopNpmSupervisedWorkerOnce(
  worker: NpmSupervisedWorker,
  signal: NodeJS.Signals
): Promise<void> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
    await worker.exit.catch(() => undefined)
    return
  }
  requestGracefulWorkerStop(worker.child, signal)
  let timeout: ReturnType<typeof setTimeout> | null = null
  const stopped = await Promise.race([
    worker.exit.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), WORKER_STOP_TIMEOUT_MS)
    })
  ]).finally(() => {
    if (timeout) {
      clearTimeout(timeout)
    }
  })
  if (!stopped) {
    worker.child.kill('SIGKILL')
    await worker.exit.catch(() => undefined)
  }
}

function requestGracefulWorkerStop(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.connected && child.send) {
    try {
      child.send(
        {
          type: 'orca:npm-worker-stop',
          protocolVersion: NPM_SUPERVISOR_PROTOCOL_VERSION,
          signal: signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM'
        },
        (error) => {
          if (error && child.exitCode === null && child.signalCode === null) {
            child.kill(signal)
          }
        }
      )
      return
    } catch {
      // IPC loss falls through to the bounded OS-level stop.
    }
  }
  child.kill(signal)
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
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
