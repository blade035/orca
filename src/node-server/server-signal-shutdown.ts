type SignalEmitter = {
  on(signal: NodeJS.Signals, listener: () => void): unknown
  off(signal: NodeJS.Signals, listener: () => void): unknown
}

export function installServerSignalShutdown(args: {
  emitter: SignalEmitter
  shutdown: (exitCode: number) => Promise<void>
  exit: (exitCode: number) => void
  getExitCode: () => number
  onSignal?: () => void
}): void {
  let exiting = false
  const stopForSignal = (): void => {
    args.onSignal?.()
    void args.shutdown(0).then(() => {
      if (exiting) {
        return
      }
      exiting = true
      args.emitter.off('SIGINT', stopForSignal)
      args.emitter.off('SIGTERM', stopForSignal)
      args.exit(args.getExitCode())
    })
  }
  args.emitter.on('SIGINT', stopForSignal)
  args.emitter.on('SIGTERM', stopForSignal)
}
