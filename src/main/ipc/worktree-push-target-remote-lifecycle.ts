const lifecycleTails = new Map<string, Promise<void>>()

export function localPushTargetRemoteLifecycleScope(
  repoPath: string,
  repoId?: string,
  wslDistro?: string
): string {
  const route = wslDistro ? `wsl:${wslDistro.toLowerCase()}` : 'local'
  return `${route}:${repoId ?? repoPath}`
}

export function sshPushTargetRemoteLifecycleScope(
  connectionId: string,
  repoPath: string,
  repoId?: string
): string {
  return `ssh:${connectionId}:${repoId ?? repoPath}`
}

export async function acquireWorktreePushTargetRemoteLifecycle(scope: string): Promise<() => void> {
  const previous = lifecycleTails.get(scope) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  lifecycleTails.set(scope, current)

  await previous
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    release()
    if (lifecycleTails.get(scope) === current) {
      lifecycleTails.delete(scope)
    }
  }
}
