export function subscribeSshFileStreamAbort(
  signal: AbortSignal | undefined,
  onAbort: (error: Error) => void
): (() => void) | null {
  if (!signal) {
    return null
  }
  const abort = (): void => {
    const error = new Error('File read was cancelled.')
    error.name = 'AbortError'
    onAbort(error)
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) {
    abort()
  }
  return () => signal.removeEventListener('abort', abort)
}
