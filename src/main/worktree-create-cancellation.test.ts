import { describe, expect, it } from 'vitest'
import { WorktreeCreateCancellation } from './worktree-create-cancellation'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

describe('WorktreeCreateCancellation', () => {
  it('joins rollback before rejecting an aborted operation', async () => {
    const controller = new AbortController()
    const cancellation = new WorktreeCreateCancellation(controller.signal)
    const cleanup = deferred()
    const cleanupStarted = deferred()
    let settled = false
    cancellation.registerRollback(async () => {
      cleanupStarted.resolve()
      await cleanup.promise
    })
    const operation = cancellation
      .run(async () => {
        controller.abort()
        return 'created'
      })
      .finally(() => {
        settled = true
      })

    await cleanupStarted.promise
    expect(settled).toBe(false)

    cleanup.resolve()
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not run rollback for an ordinary failure', async () => {
    const cancellation = new WorktreeCreateCancellation()
    let cleanupCalls = 0
    cancellation.registerRollback(async () => {
      cleanupCalls += 1
    })

    await expect(
      cancellation.run(async () => {
        throw new Error('create failed')
      })
    ).rejects.toThrow('create failed')
    expect(cleanupCalls).toBe(0)
  })

  it('joins an opted-in rollback for an ordinary failure', async () => {
    const cancellation = new WorktreeCreateCancellation()
    const calls: string[] = []
    cancellation.registerRollback(
      async () => {
        calls.push('rollback')
      },
      { onFailure: true }
    )
    cancellation.registerRelease(() => {
      calls.push('release')
    })

    await expect(
      cancellation.run(async () => {
        throw new Error('create failed')
      })
    ).rejects.toThrow('create failed')
    expect(calls).toEqual(['rollback', 'release'])
  })

  it('keeps abort rollback after disabling ordinary-failure rollback', async () => {
    const controller = new AbortController()
    const cancellation = new WorktreeCreateCancellation(controller.signal)
    let cleanupCalls = 0
    cancellation.registerRollback(
      async () => {
        cleanupCalls += 1
      },
      { onFailure: true }
    )
    cancellation.disableRollbackOnFailure()

    await expect(
      cancellation.run(async () => {
        controller.abort()
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(cleanupCalls).toBe(1)
  })
})
