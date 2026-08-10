import { describe, expect, it } from 'vitest'
import { HeadlessAutomationWorkDrain } from './headless-work-drain'

describe('HeadlessAutomationWorkDrain', () => {
  it('waits for tracked work and preserves the caller promise', async () => {
    let resolveWork!: () => void
    const work = new Promise<void>((resolve) => {
      resolveWork = resolve
    })
    const drain = new HeadlessAutomationWorkDrain(true)

    expect(drain.track(work)).toBe(work)
    let drained = false
    const draining = drain.drain().then(() => {
      drained = true
    })

    await Promise.resolve()
    expect(drained).toBe(false)
    resolveWork()
    await draining
    expect(drained).toBe(true)
  })

  it.each([true, false])(
    'observes rejected fire-and-forget work without an unhandled rejection (enabled=%s)',
    async (enabled) => {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason)
      }
      process.on('unhandledRejection', onUnhandled)

      try {
        const drain = new HeadlessAutomationWorkDrain(enabled)
        drain.track(Promise.reject(new Error('dispatch failed')))

        await drain.drain()
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(unhandled).toEqual([])
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    }
  )
})
