import { describe, expect, it, vi } from 'vitest'
import { RelayContext } from './context'
import { GitHandler } from './git-handler'
import { createMockDispatcher, type RelayDispatcher } from './git-handler-test-setup'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

describe('GitHandler worktree cancellation', () => {
  it('joins relay Git settlement before acknowledging cancellation', async () => {
    const dispatcher = createMockDispatcher()
    const handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
    const cleanupStarted = deferred()
    const releaseCleanup = deferred()
    const git = vi
      .spyOn(handler as unknown as { git: (...args: unknown[]) => Promise<unknown> }, 'git')
      .mockImplementation(async (_args, _cwd, options) => {
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => {
            cleanupStarted.resolve()
            void releaseCleanup.promise.then(() => {
              const error = new Error('cancelled')
              error.name = 'AbortError'
              reject(error)
            })
          }
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) {
            abort()
          }
        })
        return { stdout: '', stderr: '' }
      })
    const addHandler = dispatcher._requestHandlers.get('git.addWorktree')!
    const cancelHandler = dispatcher._requestHandlers.get('git.cancelAddWorktree')!
    const context = { clientId: 7, isStale: () => false }
    const add = addHandler(
      {
        repoPath: '/repo',
        branchName: 'feature',
        targetDir: '/repo-feature',
        operationId: 'operation-1'
      },
      context as never
    )
    const addSettlement = add.catch((error) => error)

    await vi.waitFor(() => expect(git).toHaveBeenCalledTimes(1))
    let cancelSettled = false
    const cancel = cancelHandler({ operationId: 'operation-1' }, context as never).finally(() => {
      cancelSettled = true
    })
    await cleanupStarted.promise
    expect(cancelSettled).toBe(false)

    releaseCleanup.resolve()
    await expect(cancel).resolves.toEqual({ cancelled: true })
    await expect(addSettlement).resolves.toMatchObject({ name: 'AbortError' })
    handler.dispose()
  })

  it('isolates cancellation by client and accepts legacy add payloads', async () => {
    const dispatcher = createMockDispatcher()
    const handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
    const git = vi
      .spyOn(handler as unknown as { git: (...args: unknown[]) => Promise<unknown> }, 'git')
      .mockResolvedValue({ stdout: '', stderr: '' })
    const addHandler = dispatcher._requestHandlers.get('git.addWorktree')!
    const cancelHandler = dispatcher._requestHandlers.get('git.cancelAddWorktree')!

    await expect(
      addHandler({ repoPath: '/repo', branchName: 'legacy', targetDir: '/repo-legacy' }, {
        clientId: 1,
        isStale: () => false
      } as never)
    ).resolves.toBeUndefined()
    await expect(
      cancelHandler({ operationId: 'missing' }, { clientId: 2, isStale: () => false } as never)
    ).resolves.toEqual({ cancelled: false })
    expect(git).toHaveBeenCalled()
    handler.dispose()
  })

  it('rejects a duplicate client operation before starting another Git command', async () => {
    const dispatcher = createMockDispatcher()
    const handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
    const releaseGit = deferred()
    const git = vi
      .spyOn(handler as unknown as { git: (...args: unknown[]) => Promise<unknown> }, 'git')
      .mockImplementation(async () => {
        await releaseGit.promise
        return { stdout: '', stderr: '' }
      })
    const addHandler = dispatcher._requestHandlers.get('git.addWorktree')!
    const context = { clientId: 7, isStale: () => false }
    const params = {
      repoPath: '/repo',
      branchName: 'feature',
      targetDir: '/repo-feature',
      operationId: 'operation-1'
    }
    const first = addHandler(params, context as never)

    await vi.waitFor(() => expect(git).toHaveBeenCalledTimes(1))
    await expect(addHandler(params, context as never)).rejects.toThrow(
      'Git worktree add operation ID is already pending for this client'
    )
    expect(git).toHaveBeenCalledTimes(1)

    releaseGit.resolve()
    await expect(first).resolves.toBeUndefined()
    handler.dispose()
  })

  it('caps concurrent worktree additions before starting Git', async () => {
    const dispatcher = createMockDispatcher()
    const handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
    const releaseGit = deferred()
    const git = vi
      .spyOn(handler as unknown as { git: (...args: unknown[]) => Promise<unknown> }, 'git')
      .mockImplementation(async () => {
        await releaseGit.promise
        return { stdout: '', stderr: '' }
      })
    const addHandler = dispatcher._requestHandlers.get('git.addWorktree')!
    const context = { clientId: 7, isStale: () => false }
    const additions = Array.from({ length: 64 }, (_, index) =>
      addHandler(
        {
          repoPath: '/repo',
          branchName: `feature-${index}`,
          targetDir: `/repo-feature-${index}`,
          operationId: `operation-${index}`
        },
        context as never
      )
    )

    await vi.waitFor(() => expect(git).toHaveBeenCalledTimes(64))
    await expect(
      addHandler(
        {
          repoPath: '/repo',
          branchName: 'overflow',
          targetDir: '/repo-overflow',
          operationId: 'operation-overflow'
        },
        context as never
      )
    ).rejects.toThrow('Too many Git worktree additions are still pending')
    expect(git).toHaveBeenCalledTimes(64)

    releaseGit.resolve()
    await expect(Promise.all(additions)).resolves.toEqual(Array(64).fill(undefined))
    handler.dispose()
  })

  it('forwards request cancellation through remote worktree removal', async () => {
    const dispatcher = createMockDispatcher()
    const handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
    const controller = new AbortController()
    const git = vi
      .spyOn(handler as unknown as { git: (...args: unknown[]) => Promise<unknown> }, 'git')
      .mockImplementation(async (_args, _cwd, options) => {
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal
        expect(signal).toBe(controller.signal)
        signal?.throwIfAborted()
        return { stdout: '', stderr: '' }
      })
    const removeHandler = dispatcher._requestHandlers.get('git.removeWorktree')!
    controller.abort()

    await expect(
      removeHandler({ worktreePath: '/repo-feature', force: true }, {
        clientId: 7,
        isStale: () => false,
        signal: controller.signal
      } as never)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(git).toHaveBeenCalled()
    handler.dispose()
  })
})
