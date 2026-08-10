import { describe, expect, it, vi } from 'vitest'
import { createServerShutdownCoordinator } from './server-shutdown-coordinator'

describe('server shutdown coordinator', () => {
  it('joins concurrent shutdown requests and retains a later failure code', async () => {
    let finish!: () => void
    const barrier = new Promise<void>((resolve) => {
      finish = resolve
    })
    const observedExitCodes: number[] = []
    const run = vi.fn(async (getRequestedExitCode: () => number) => {
      await barrier
      observedExitCodes.push(getRequestedExitCode())
    })
    const shutdown = createServerShutdownCoordinator(run)

    const first = shutdown(0)
    const second = shutdown(1)

    expect(second).toBe(first)
    expect(run).toHaveBeenCalledTimes(1)
    finish()
    await first
    expect(observedExitCodes).toEqual([1])
  })
})
