import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAutomationPrecheck } from './precheck-runner'

const sshManagerState = vi.hoisted(() => ({
  manager: null as null | {
    getConnection: ReturnType<typeof vi.fn>
  }
}))

vi.mock('../ipc/ssh', () => ({
  getSshConnectionManager: () => sshManagerState.manager
}))

function sshTarget(): { type: 'ssh'; cwd: string; connectionId: string } {
  return { type: 'ssh', cwd: '/repo/path', connectionId: 'ssh-1' }
}

describe('SSH automation precheck timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
    sshManagerState.manager = null
  })

  it('bounds SSH channel acquisition with the precheck deadline', async () => {
    vi.useFakeTimers()
    const exec = vi.fn(() => new Promise<never>(() => undefined))
    sshManagerState.manager = {
      getConnection: vi.fn(() => ({
        getState: () => ({ status: 'connected' }),
        exec
      }))
    }

    const resultPromise = runAutomationPrecheck({
      precheck: { command: 'long-command', timeoutSeconds: 1 },
      target: sshTarget()
    })
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: null,
      timedOut: true,
      error: 'Precheck timed out after 1s.'
    })
  })

  it('hard-destroys a half-open channel and releases its listeners', async () => {
    vi.useFakeTimers()
    const channel = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
      close: vi.fn(),
      destroy: vi.fn()
    })
    channel.close.mockImplementation(() =>
      channel.emit('error', new Error('close transport error'))
    )
    channel.destroy.mockImplementation(() => channel.emit('close'))
    sshManagerState.manager = {
      getConnection: vi.fn(() => ({
        getState: () => ({ status: 'connected' }),
        exec: vi.fn(async () => channel)
      }))
    }
    const resultPromise = runAutomationPrecheck({
      precheck: { command: 'long-command', timeoutSeconds: 1 },
      target: sshTarget()
    })
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: null,
      timedOut: true,
      error: 'Precheck timed out after 1s.'
    })
    expect(channel.close).toHaveBeenCalledTimes(1)
    expect(channel.destroy).toHaveBeenCalledTimes(1)
    expect(channel.listenerCount('data')).toBe(0)
    expect(channel.stderr.listenerCount('data')).toBe(0)
    expect(channel.listenerCount('error')).toBe(0)
    expect(channel.stderr.listenerCount('error')).toBe(0)
  })

  it('uses one deadline across acquisition and channel execution', async () => {
    vi.useFakeTimers()
    let resolveExec!: (channel: EventEmitter & { stderr: PassThrough; close: () => void }) => void
    const execPromise = new Promise<EventEmitter & { stderr: PassThrough; close: () => void }>(
      (resolve) => {
        resolveExec = resolve
      }
    )
    const channel = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
      close: vi.fn(),
      destroy: vi.fn()
    })
    sshManagerState.manager = {
      getConnection: vi.fn(() => ({
        getState: () => ({ status: 'connected' }),
        exec: vi.fn(() => execPromise)
      }))
    }
    const resultPromise = runAutomationPrecheck({
      precheck: { command: 'long-command', timeoutSeconds: 1 },
      target: sshTarget()
    })

    await vi.advanceTimersByTimeAsync(750)
    resolveExec(channel)
    await vi.advanceTimersByTimeAsync(249)
    expect(channel.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await expect(resultPromise).resolves.toMatchObject({ timedOut: true })
    expect(channel.close).toHaveBeenCalledTimes(1)
    channel.emit('close')
  })
})
