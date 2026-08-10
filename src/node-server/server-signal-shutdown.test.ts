import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createServerShutdownCoordinator } from './server-shutdown-coordinator'
import { installServerSignalShutdown } from './server-signal-shutdown'

describe('server signal shutdown', () => {
  it('retains signal handlers until repeated signals join teardown', async () => {
    const emitter = new EventEmitter()
    let finish!: () => void
    const barrier = new Promise<void>((resolve) => {
      finish = resolve
    })
    const run = vi.fn(async () => barrier)
    const shutdown = createServerShutdownCoordinator(async () => run())
    const exit = vi.fn()
    const onSignal = vi.fn()
    installServerSignalShutdown({ emitter, shutdown, exit, getExitCode: () => 0, onSignal })

    emitter.emit('SIGTERM')
    emitter.emit('SIGTERM')
    expect(onSignal).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()
    expect(emitter.listenerCount('SIGTERM')).toBe(1)

    finish()
    await barrier
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(exit).toHaveBeenCalledOnce()
    expect(emitter.listenerCount('SIGINT')).toBe(0)
    expect(emitter.listenerCount('SIGTERM')).toBe(0)
  })

  it('forces a failed exit when joined teardown exceeds its deadline', async () => {
    vi.useFakeTimers()
    const emitter = new EventEmitter()
    let finish!: () => void
    const barrier = new Promise<void>((resolve) => {
      finish = resolve
    })
    const exit = vi.fn()
    const onForceExit = vi.fn()
    installServerSignalShutdown({
      emitter,
      shutdown: async () => barrier,
      exit,
      getExitCode: () => 0,
      forceExitMs: 30_000,
      onForceExit
    })

    emitter.emit('SIGTERM')
    await vi.advanceTimersByTimeAsync(29_999)
    expect(exit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(onForceExit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)

    finish()
    await barrier
    await vi.runAllTimersAsync()
    expect(exit).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('clears the force-exit deadline after normal teardown', async () => {
    vi.useFakeTimers()
    const emitter = new EventEmitter()
    const exit = vi.fn()
    const onForceExit = vi.fn()
    installServerSignalShutdown({
      emitter,
      shutdown: async () => undefined,
      exit,
      getExitCode: () => 0,
      forceExitMs: 30_000,
      onForceExit
    })

    emitter.emit('SIGTERM')
    await Promise.resolve()
    await vi.runAllTimersAsync()
    expect(exit).toHaveBeenCalledWith(0)
    expect(onForceExit).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
