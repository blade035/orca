import { describe, expect, it, vi } from 'vitest'
import { SshFilesystemProvider } from './ssh-filesystem-provider'
import { SshFilesystemMutationSettlementError } from './ssh-filesystem-mutation-settlement'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

describe('SshFilesystemProvider cancellation', () => {
  it('forwards cancellation through setup reads', async () => {
    const request = vi.fn().mockResolvedValue({ totalSize: 0, isBinary: false, empty: true })
    const provider = new SshFilesystemProvider('conn-1', {
      request,
      notify: vi.fn(),
      onNotification: vi.fn(() => vi.fn()),
      onNotificationByMethod: vi.fn(() => vi.fn()),
      onDispose: vi.fn(() => vi.fn()),
      isDisposed: vi.fn(() => false)
    } as never)
    const controller = new AbortController()
    const options = { signal: controller.signal }

    await provider.readFile('/home/user/orca.yaml', options)

    expect(request).toHaveBeenCalledWith(
      'fs.readFileStream',
      { filePath: '/home/user/orca.yaml', flowControl: 'ack' },
      options
    )
  })

  it('releases a confirmed setup mutation', async () => {
    const request = vi.fn().mockResolvedValue({ mutationTracked: true })
    const notify = vi.fn()
    const provider = new SshFilesystemProvider('conn-1', {
      request,
      notify,
      onNotification: vi.fn(() => vi.fn())
    } as never)

    await provider.createDir('/repo/.git/worktrees/feature/orca', {
      requireSettlement: true
    })

    const operationId = request.mock.calls[0][1].operationId
    expect(request).toHaveBeenCalledWith(
      'fs.createDir',
      {
        dirPath: '/repo/.git/worktrees/feature/orca',
        operationId
      },
      { timeoutMs: 8_000 }
    )
    expect(notify).toHaveBeenCalledWith('fs.releaseMutation', { operationId })
  })

  it('joins authoritative mutation settlement after the original request fails', async () => {
    const settlement = deferred<{ found: boolean }>()
    const mutationError = new Error('request timed out')
    const request = vi.fn((method: string) =>
      method === 'fs.writeFile' ? Promise.reject(mutationError) : settlement.promise
    )
    const provider = new SshFilesystemProvider('conn-1', {
      request,
      notify: vi.fn(),
      onNotification: vi.fn(() => vi.fn())
    } as never)
    const write = provider.writeFile('/repo/.git/worktrees/feature/orca/setup.sh', 'echo ok', {
      requireSettlement: true
    })
    let settled = false
    const result = write
      .catch((error) => error)
      .finally(() => {
        settled = true
      })

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    expect(settled).toBe(false)
    settlement.resolve({ found: true })

    await expect(result).resolves.toBe(mutationError)
  })

  it('marks rollback unsafe when relay settlement is unavailable', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('request timed out'))
      .mockRejectedValueOnce(new Error('connection lost'))
    const provider = new SshFilesystemProvider('conn-1', {
      request,
      notify: vi.fn(),
      onNotification: vi.fn(() => vi.fn())
    } as never)

    await expect(
      provider.createDir('/repo/.git/worktrees/feature/orca', {
        requireSettlement: true
      })
    ).rejects.toBeInstanceOf(SshFilesystemMutationSettlementError)
  })
})
