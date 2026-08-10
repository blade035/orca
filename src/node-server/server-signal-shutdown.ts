type SignalEmitter = {
  on(signal: NodeJS.Signals, listener: () => void): unknown
  off(signal: NodeJS.Signals, listener: () => void): unknown
}

export const SERVER_SHUTDOWN_FORCE_EXIT_MS = 30_000

export function installServerSignalShutdown(args: {
  emitter: SignalEmitter
  shutdown: (exitCode: number) => Promise<void>
  exit: (exitCode: number) => void
  getExitCode: () => number
  onSignal?: () => void
  forceExitMs?: number
  onForceExit?: () => void
}): void {
  let exiting = false
  let forceExitTimer: ReturnType<typeof setTimeout> | null = null
  const finish = (exitCode: number): void => {
    if (exiting) {
      return
    }
    exiting = true
    if (forceExitTimer) {
      clearTimeout(forceExitTimer)
      forceExitTimer = null
    }
    args.emitter.off('SIGINT', stopForSignal)
    args.emitter.off('SIGTERM', stopForSignal)
    args.exit(exitCode)
  }
  const stopForSignal = (): void => {
    args.onSignal?.()
    forceExitTimer ??= setTimeout(() => {
      args.onForceExit?.()
      finish(1)
    }, args.forceExitMs ?? SERVER_SHUTDOWN_FORCE_EXIT_MS)
    void args.shutdown(0).then(
      () => finish(args.getExitCode()),
      () => finish(1)
    )
  }
  args.emitter.on('SIGINT', stopForSignal)
  args.emitter.on('SIGTERM', stopForSignal)
}
