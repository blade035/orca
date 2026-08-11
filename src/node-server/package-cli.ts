#!/usr/bin/env node
export {}

const argv = process.argv.slice(2)
const internalWorker = argv[0] === '__orca-npm-worker'
const internalPreflight = argv[0] === '__orca-npm-preflight'
const directServerCommand =
  argv[0] === 'version' ||
  argv[0] === '--version' ||
  argv[0] === '-v' ||
  (argv[0] === 'serve' &&
    argv.slice(1).some((arg) => ['--help', '-h', '--version', '-v'].includes(arg)))
const supervisedServe = argv.length === 0 || argv[0] === 'serve'

if (internalWorker) {
  // Parent loss is a host crash; exit immediately so the next supervisor can recover the profile.
  let disconnectingAfterFailure = false
  process.once('disconnect', () =>
    process.exit(disconnectingAfterFailure ? (process.exitCode ?? 1) : 1)
  )
  let signalHandlersReady = false
  let pendingStopSignal: 'SIGINT' | 'SIGTERM' | null = null
  let commitReceived = false
  let resolveCommit: (() => void) | null = null
  process.on('message', (value) => {
    void import('./npm-supervisor-protocol').then((protocol) => {
      const { parseNpmSupervisorMessage } = protocol
      const message = parseNpmSupervisorMessage(value)
      if (message?.type === 'orca:npm-worker-commit') {
        commitReceived = true
        resolveCommit?.()
        void protocol.notifyNpmSupervisorCommitApplied().catch(() => undefined)
        return
      }
      if (message?.type === 'orca:npm-update-failed') {
        void import('./npm-server-updater').then(({ reportNpmSupervisorActivationFailure }) => {
          reportNpmSupervisorActivationFailure(message)
          void protocol
            .notifyNpmSupervisorOutcomeApplied('orca:npm-update-failure-applied', message.requestId)
            .catch(() => undefined)
        })
        return
      }
      if (message?.type === 'orca:npm-update-committed') {
        void import('./npm-server-updater').then(({ reportNpmSupervisorActivationSuccess }) => {
          reportNpmSupervisorActivationSuccess(message)
          void protocol
            .notifyNpmSupervisorOutcomeApplied('orca:npm-update-success-applied', message.requestId)
            .catch(() => undefined)
        })
        return
      }
      if (message?.type === 'orca:npm-worker-stop') {
        pendingStopSignal = message.signal
        if (signalHandlersReady) {
          process.emit(message.signal)
        }
      }
    })
  })
  void Promise.all([import('./index'), import('./npm-supervisor-protocol')]).then(
    ([{ reportNodeServerFailure, runNodeServer }, { notifyNpmSupervisorPrepared }]) =>
      runNodeServer(argv.slice(1), {
        beforeRpcStart: async (runtimeId, signal) => {
          await notifyNpmSupervisorPrepared(
            (await import('./npm-runtime-version')).readNpmRuntimeVersion(),
            runtimeId
          )
          if (commitReceived) {
            return
          }
          await new Promise<void>((resolve, reject) => {
            const onAbort = (): void => reject(signal.reason)
            resolveCommit = () => {
              signal.removeEventListener('abort', onAbort)
              resolve()
            }
            signal.addEventListener('abort', onAbort, { once: true })
            if (commitReceived) {
              resolveCommit()
            }
          })
        },
        onSignalHandlersReady: () => {
          signalHandlersReady = true
          if (pendingStopSignal) {
            process.emit(pendingStopSignal)
          }
        }
      }).catch((error: unknown) => {
        reportNodeServerFailure(error)
        disconnectingAfterFailure = true
        process.disconnect?.()
      })
  )
} else if (internalPreflight) {
  void import('./npm-server-preflight').then(({ runNpmServerPreflight }) =>
    runNpmServerPreflight(argv.slice(1))
  )
} else if (directServerCommand) {
  void import('./index').then(({ reportNodeServerFailure, runNodeServer }) =>
    runNodeServer(argv).catch(reportNodeServerFailure)
  )
} else if (supervisedServe) {
  void import('./npm-serve-supervisor').then(({ runNpmServeSupervisor }) =>
    runNpmServeSupervisor(argv)
      .then((exitCode) => {
        process.exitCode = exitCode
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `Orca server supervisor failed: ${error instanceof Error ? error.message : String(error)}\n`
        )
        process.exitCode = 1
      })
  )
} else {
  void Promise.all([import('../cli/cli-program'), import('./server-profile-environment')]).then(
    ([{ main: runControlCli }, { configureServerControlProfileEnvironment }]) => {
      configureServerControlProfileEnvironment()
      return runControlCli(argv)
    }
  )
}
