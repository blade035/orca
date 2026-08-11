import type { NpmWorkerReadyMessage, NpmUpdateActivationMessage } from './npm-supervisor-protocol'
import {
  clearActiveNpmRuntime,
  commitNpmHandoff,
  failNpmHandoff,
  type NpmSupervisorState
} from './npm-supervisor-state'
import type {
  commitNpmSupervisedWorker,
  reportNpmActivationFailure,
  spawnNpmSupervisedWorker,
  stopNpmSupervisedWorker,
  waitForNpmWorkerPrepared,
  waitForNpmWorkerReady,
  NpmSupervisedWorker
} from './npm-supervised-worker'

export type NpmWorkerSelection = {
  entryPath: string
  version: string
  fallback?: { entryPath: string; version: string }
}

export type RunningNpmWorker = {
  worker: NpmSupervisedWorker
  ready: NpmWorkerReadyMessage
}

type NpmWorkerLifecycle = {
  spawnWorker: typeof spawnNpmSupervisedWorker
  stopWorker: typeof stopNpmSupervisedWorker
  commitWorker: typeof commitNpmSupervisedWorker
  reportFailure: typeof reportNpmActivationFailure
  waitForPrepared: typeof waitForNpmWorkerPrepared
  waitForReady: typeof waitForNpmWorkerReady
  getStoppingSignal: () => NodeJS.Signals | null
  failHandoff?: typeof failNpmHandoff
}

export async function startInitialNpmWorker(
  selection: NpmWorkerSelection,
  argv: string[],
  state: NpmSupervisorState,
  dataPath: string,
  lifecycle: NpmWorkerLifecycle & { onSpawn: (worker: NpmSupervisedWorker) => void }
): Promise<{ running: RunningNpmWorker; state: NpmSupervisorState } | { exitCode: number }> {
  let current = selection
  while (true) {
    const worker = lifecycle.spawnWorker(current.entryPath, argv)
    lifecycle.onSpawn(worker)
    try {
      await lifecycle.waitForPrepared(worker, current.version)
      await lifecycle.commitWorker(worker)
      const ready = await lifecycle.waitForReady(worker, current.version)
      return { running: { worker, ready }, state }
    } catch (error) {
      const signal = lifecycle.getStoppingSignal()
      await lifecycle.stopWorker(worker, signal ?? 'SIGTERM').catch(() => undefined)
      if (signal) {
        return { exitCode: 0 }
      }
      if (error instanceof Error && error.message === 'npm_update_worker_exited_before_ready') {
        const exit = await worker.exit
        if (exit.code === 3 || !current.fallback) {
          return { exitCode: exit.code ?? 1 }
        }
      } else if (!current.fallback) {
        throw error
      }
      state = await clearActiveNpmRuntime(dataPath, state)
      current = current.fallback!
    }
  }
}

export async function rollbackNpmHandoffWorker(
  dataPath: string,
  state: NpmSupervisorState,
  activation: NpmUpdateActivationMessage,
  previous: { entryPath: string; version: string },
  argv: string[],
  lifecycle: NpmWorkerLifecycle,
  onSpawn: (worker: NpmSupervisedWorker) => void,
  reason: string
): Promise<{
  state: NpmSupervisorState
  worker: NpmSupervisedWorker
  ready: NpmWorkerReadyMessage
} | null> {
  const persistFailure = lifecycle.failHandoff ?? failNpmHandoff
  let next = state
  let repairFailureState = false
  try {
    next = await persistFailure(dataPath, state, activation, reason)
  } catch {
    repairFailureState = true
  }
  if (lifecycle.getStoppingSignal()) {
    return null
  }
  const worker = lifecycle.spawnWorker(previous.entryPath, argv)
  onSpawn(worker)
  const signal = lifecycle.getStoppingSignal()
  if (signal) {
    await lifecycle.stopWorker(worker, signal)
    return null
  }
  let ready: NpmWorkerReadyMessage
  try {
    await lifecycle.waitForPrepared(worker, previous.version)
    await lifecycle
      .reportFailure(worker, {
        requestId: activation.requestId,
        fromVersion: activation.fromVersion,
        targetVersion: activation.targetVersion,
        originRuntimeId: activation.runtimeId,
        reason
      })
      .catch(() => undefined)
    await lifecycle.commitWorker(worker)
    ready = await lifecycle.waitForReady(worker, previous.version)
  } catch (error) {
    await lifecycle.stopWorker(worker, lifecycle.getStoppingSignal() ?? 'SIGTERM')
    if (lifecycle.getStoppingSignal()) {
      return null
    }
    throw error
  }
  if (repairFailureState) {
    next = await persistFailure(dataPath, state, activation, reason)
  }
  return { state: next, worker, ready }
}

export async function commitNpmCandidateWhileAlive(
  dataPath: string,
  state: NpmSupervisorState,
  activation: NpmUpdateActivationMessage,
  candidate: NpmSupervisedWorker
): Promise<NpmSupervisorState> {
  const commit = commitNpmHandoff(dataPath, state, activation)
  const outcome = await Promise.race([
    commit.then((next) => ({ type: 'commit' as const, next })),
    candidate.exit.then(() => ({ type: 'exit' as const }))
  ])
  if (outcome.type === 'exit') {
    await commit.catch(() => undefined)
    throw new Error('npm_update_worker_exited_during_commit')
  }
  return outcome.next
}
