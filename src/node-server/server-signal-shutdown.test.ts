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
})
