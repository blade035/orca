import { describe, expect, it } from 'vitest'
import {
  acquireWorktreePushTargetRemoteLifecycle,
  localPushTargetRemoteLifecycleScope,
  sshPushTargetRemoteLifecycleScope
} from './worktree-push-target-remote-lifecycle'

describe('worktree push-target remote lifecycle', () => {
  it('serializes operations in the same repository scope', async () => {
    const firstScope = localPushTargetRemoteLifecycleScope('/repo', 'repo-1')
    const aliasScope = localPushTargetRemoteLifecycleScope('/repo-alias', 'repo-1')
    expect(aliasScope).toBe(firstScope)

    const events: string[] = []
    const releaseFirst = await acquireWorktreePushTargetRemoteLifecycle(firstScope)
    events.push('first')
    const second = acquireWorktreePushTargetRemoteLifecycle(aliasScope).then((release) => {
      events.push('second')
      return release
    })

    await Promise.resolve()
    expect(events).toEqual(['first'])

    releaseFirst()
    const releaseSecond = await second
    expect(events).toEqual(['first', 'second'])
    releaseSecond()
  })

  it('remains usable when a rejected operation releases in finally', async () => {
    const scope = localPushTargetRemoteLifecycleScope('/repo', 'repo-rejection')

    await expect(
      (async () => {
        const release = await acquireWorktreePushTargetRemoteLifecycle(scope)
        try {
          throw new Error('operation failed')
        } finally {
          release()
        }
      })()
    ).rejects.toThrow('operation failed')

    const releaseRecovered = await acquireWorktreePushTargetRemoteLifecycle(scope)
    releaseRecovered()
  })

  it('allows different repository scopes to overlap', async () => {
    const releaseFirst = await acquireWorktreePushTargetRemoteLifecycle(
      localPushTargetRemoteLifecycleScope('/repo-a', 'repo-a')
    )
    const releaseSecond = await acquireWorktreePushTargetRemoteLifecycle(
      localPushTargetRemoteLifecycleScope('/repo-b', 'repo-b')
    )

    releaseSecond()
    releaseFirst()
  })

  it('isolates identical repository paths across SSH connections and WSL distros', async () => {
    const repoPath = '/srv/orca'
    const repoId = 'repo-remote'
    const scopes = [
      sshPushTargetRemoteLifecycleScope('ssh-a', repoPath, repoId),
      sshPushTargetRemoteLifecycleScope('ssh-b', repoPath, repoId),
      localPushTargetRemoteLifecycleScope(repoPath, repoId, 'Ubuntu'),
      localPushTargetRemoteLifecycleScope(repoPath, repoId, 'Debian')
    ]
    expect(new Set(scopes).size).toBe(scopes.length)

    const releases: (() => void)[] = []
    for (const scope of scopes) {
      releases.push(await acquireWorktreePushTargetRemoteLifecycle(scope))
    }
    releases.toReversed().forEach((release) => release())
  })
})
