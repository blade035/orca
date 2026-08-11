import { realpathSync } from 'node:fs'
import { compareAppVersions } from '../shared/app-version'
import { preflightPinnedNpmRuntime, verifyPinnedNpmRuntime } from './npm-pinned-runtime'
import { getNpmSupervisorLockRoot } from './npm-runtime-paths'
import { readNpmRuntimeVersion } from './npm-runtime-version'
import { resolveServerDataPath } from './server-paths'
import { parseServerCliArguments } from './server-cli-arguments'
import {
  npmActivationFailure,
  npmActivationRejectionReason,
  safeNpmSupervisorError
} from './npm-supervisor-activation'
import {
  commitNpmSupervisedWorker,
  reportNpmActivationFailure,
  reportNpmActivationSuccess,
  spawnNpmSupervisedWorker,
  stopNpmSupervisedWorker,
  waitForNpmWorkerPrepared,
  waitForNpmWorkerReady,
  type NpmSupervisedWorker
} from './npm-supervised-worker'
import {
  acquireServerProfileProcessLock,
  ServerProfileProcessLockError
} from './server-profile-process-lock'
import {
  beginNpmHandoff,
  readNpmSupervisorState,
  recoverInterruptedNpmHandoff,
  type NpmSupervisorState
} from './npm-supervisor-state'
import {
  commitNpmCandidateWhileAlive,
  rollbackNpmHandoffWorker,
  startInitialNpmWorker,
  type NpmWorkerSelection
} from './npm-supervisor-worker-transition'

export type NpmServeSupervisorDependencies = {
  launcherEntry?: string
  spawnWorker?: typeof spawnNpmSupervisedWorker
  stopWorker?: typeof stopNpmSupervisedWorker
  verifyPinnedRuntime?: typeof verifyPinnedNpmRuntime
  preflightPinnedRuntime?: typeof preflightPinnedNpmRuntime
  waitForPrepared?: typeof waitForNpmWorkerPrepared
  waitForReady?: typeof waitForNpmWorkerReady
  commitWorker?: typeof commitNpmSupervisedWorker
  reportFailure?: typeof reportNpmActivationFailure
  reportSuccess?: typeof reportNpmActivationSuccess
  beginHandoff?: typeof beginNpmHandoff
  commitCandidate?: typeof commitNpmCandidateWhileAlive
}

export async function runNpmServeSupervisor(
  argv: string[],
  dependencies: NpmServeSupervisorDependencies = {}
): Promise<number> {
  const spawnWorker = dependencies.spawnWorker ?? spawnNpmSupervisedWorker
  const stopWorker = dependencies.stopWorker ?? stopNpmSupervisedWorker
  const preflightPinnedRuntime =
    dependencies.preflightPinnedRuntime ??
    dependencies.verifyPinnedRuntime ??
    preflightPinnedNpmRuntime
  const waitForPrepared = dependencies.waitForPrepared ?? waitForNpmWorkerPrepared
  const waitForReady = dependencies.waitForReady ?? waitForNpmWorkerReady
  const commitWorker = dependencies.commitWorker ?? commitNpmSupervisedWorker
  const reportFailure = dependencies.reportFailure ?? reportNpmActivationFailure
  const reportSuccess = dependencies.reportSuccess ?? reportNpmActivationSuccess
  const beginHandoff = dependencies.beginHandoff ?? beginNpmHandoff
  const commitCandidate = dependencies.commitCandidate ?? commitNpmCandidateWhileAlive
  const parsed = parseServerCliArguments(argv)
  if (parsed.command !== 'serve') {
    throw new Error('npm_supervisor_requires_serve')
  }
  const dataPath = resolveServerDataPath(parsed.dataPath)
  const supervisorLock = await acquireServerProfileProcessLock(
    getNpmSupervisorLockRoot(dataPath)
  ).catch((error: unknown) => {
    if (error instanceof ServerProfileProcessLockError && error.reason === 'already_owned') {
      return null
    }
    throw error
  })
  if (!supervisorLock) {
    return 3
  }
  try {
    const launcherEntry = dependencies.launcherEntry ?? realpathSync(process.argv[1]!)
    const launcherVersion = readNpmRuntimeVersion()
    let state = await readNpmSupervisorState(dataPath)
    const interrupted = state.pending
    try {
      state = await recoverInterruptedNpmHandoff(dataPath, state)
    } catch {
      // The running worker receives the recovery failure even if disk persistence is unavailable.
    }
    const selected = await selectInitialWorker(dataPath, launcherEntry, launcherVersion, state)
    let worker: NpmSupervisedWorker | null = null
    let stoppingSignal: NodeJS.Signals | null = null
    const supervisorAbortController = new AbortController()
    const forwardSignal = (signal: NodeJS.Signals): void => {
      stoppingSignal ??= signal
      supervisorAbortController.abort()
      if (worker) {
        void stopWorker(worker, stoppingSignal).catch(() => undefined)
      }
    }
    process.on('SIGINT', forwardSignal)
    process.on('SIGTERM', forwardSignal)

    try {
      const initial = await startInitialNpmWorker(selected, argv, state, dataPath, {
        spawnWorker,
        stopWorker,
        commitWorker,
        reportFailure,
        waitForPrepared,
        waitForReady,
        getStoppingSignal: () => stoppingSignal,
        onSpawn: (next) => {
          worker = next
        }
      })
      if ('exitCode' in initial) {
        return initial.exitCode
      }
      state = initial.state
      worker = initial.running.worker
      let ready = initial.running.ready
      if (interrupted) {
        await reportFailure(worker, {
          ...interrupted,
          reason: 'npm_update_supervisor_interrupted'
        }).catch(() => undefined)
      } else if (state.completed) {
        await reportSuccess(worker, state.completed.requestId).catch(() => undefined)
      }
      while (true) {
        const outcome = await Promise.race([
          worker.exit.then((exit) => ({ type: 'exit' as const, exit })),
          worker
            .nextActivation()
            .then((activation) => ({ type: 'activation' as const, activation }))
        ])
        if (outcome.type === 'exit') {
          if (stoppingSignal) {
            return outcome.exit.code ?? 0
          }
          return outcome.exit.code ?? 1
        }

        const activation = outcome.activation
        const rejection = npmActivationRejectionReason(activation, ready)
        if (rejection) {
          await reportFailure(worker, npmActivationFailure(activation, rejection)).catch(
            () => undefined
          )
          continue
        }
        let candidateEntry: string | null
        try {
          candidateEntry = await preflightPinnedRuntime(
            dataPath,
            activation.targetVersion,
            supervisorAbortController.signal
          )
        } catch (error) {
          if (stoppingSignal) {
            await stopWorker(worker, stoppingSignal).catch(() => undefined)
            return 0
          }
          await reportFailure(
            worker,
            npmActivationFailure(activation, safeNpmSupervisorError(error))
          ).catch(() => undefined)
          continue
        }
        if (stoppingSignal) {
          await stopWorker(worker, stoppingSignal).catch(() => undefined)
          return 0
        }
        if (!candidateEntry) {
          await reportFailure(
            worker,
            npmActivationFailure(activation, 'npm_update_candidate_missing')
          ).catch(() => undefined)
          continue
        }
        try {
          state = await beginHandoff(dataPath, state, activation)
        } catch {
          await reportFailure(
            worker,
            npmActivationFailure(activation, 'npm_update_state_write_failed')
          ).catch(() => undefined)
          continue
        }
        if (stoppingSignal) {
          await stopWorker(worker, stoppingSignal)
          return 0
        }

        const previous = { entryPath: worker.entryPath, version: ready.version }
        const rollbackState = state
        await stopWorker(worker, 'SIGTERM')
        if (stoppingSignal) {
          return 0
        }
        const candidate = spawnWorker(candidateEntry, argv)
        worker = candidate
        if (stoppingSignal) {
          await stopWorker(candidate, stoppingSignal)
          return 0
        }
        try {
          await waitForPrepared(candidate, activation.targetVersion)
          state = await commitCandidate(dataPath, state, activation, candidate)
          await commitWorker(candidate)
          const candidateReady = await waitForReady(candidate, activation.targetVersion)
          await reportSuccess(candidate, activation.requestId)
          worker = candidate
          ready = candidateReady
        } catch (error) {
          await stopWorker(candidate, 'SIGTERM')
          if (stoppingSignal) {
            return 0
          }
          const rollback = await rollbackNpmHandoffWorker(
            dataPath,
            rollbackState,
            activation,
            previous,
            argv,
            {
              spawnWorker,
              stopWorker,
              commitWorker,
              reportFailure,
              waitForPrepared,
              waitForReady,
              getStoppingSignal: () => stoppingSignal
            },
            (nextWorker) => {
              worker = nextWorker
            },
            safeNpmSupervisorError(error)
          )
          if (!rollback) {
            return 0
          }
          state = rollback.state
          worker = rollback.worker
          ready = rollback.ready
        }
      }
    } catch (error) {
      if (worker) {
        await stopWorker(worker, stoppingSignal ?? 'SIGTERM').catch(() => undefined)
      }
      if (stoppingSignal) {
        return 0
      }
      throw error
    } finally {
      process.off('SIGINT', forwardSignal)
      process.off('SIGTERM', forwardSignal)
    }
  } finally {
    await supervisorLock.release()
  }
}

async function selectInitialWorker(
  dataPath: string,
  launcherEntry: string,
  launcherVersion: string,
  state: NpmSupervisorState
): Promise<NpmWorkerSelection> {
  if (state.activeVersion && compareAppVersions(state.activeVersion, launcherVersion) > 0) {
    const pinned = await verifyPinnedNpmRuntime(dataPath, state.activeVersion)
    if (pinned) {
      return {
        entryPath: pinned,
        version: state.activeVersion,
        fallback: { entryPath: launcherEntry, version: launcherVersion }
      }
    }
  }
  return { entryPath: launcherEntry, version: launcherVersion }
}
