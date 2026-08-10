export function createServerShutdownCoordinator(
  run: (getRequestedExitCode: () => number) => Promise<void>
): (exitCode: number) => Promise<void> {
  let requestedExitCode = 0
  let shutdownPromise: Promise<void> | null = null
  return (exitCode) => {
    requestedExitCode = Math.max(requestedExitCode, exitCode)
    shutdownPromise ??= run(() => requestedExitCode)
    return shutdownPromise
  }
}
