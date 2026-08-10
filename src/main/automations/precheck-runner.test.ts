import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAutomationPrecheck } from './precheck-runner'

const sshManagerState = vi.hoisted(() => ({
  manager: null as null | {
    getConnection: ReturnType<typeof vi.fn>
  }
}))

vi.mock('../ipc/ssh', () => ({
  getSshConnectionManager: () => sshManagerState.manager
}))

const node = JSON.stringify(process.execPath)

function nodeCommand(script: string): string {
  return `${node} -e ${JSON.stringify(script)}`
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('runAutomationPrecheck', () => {
  let cwd = ''

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'orca-precheck-test-'))
    sshManagerState.manager = null
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('captures exit code and output for a non-zero local precheck', async () => {
    const result = await runAutomationPrecheck({
      precheck: {
        command: nodeCommand(
          "console.log('stdout text'); console.error('stderr text'); process.exit(7)"
        ),
        timeoutSeconds: 5
      },
      target: { type: 'local', cwd }
    })

    expect(result.exitCode).toBe(7)
    expect(result.timedOut).toBe(false)
    expect(result.stdout).toContain('stdout text')
    expect(result.stderr).toContain('stderr text')
    expect(result.error).toBeNull()
  })

  it('marks a local precheck as timed out', async () => {
    const result = await runAutomationPrecheck({
      precheck: {
        command: nodeCommand('setTimeout(() => {}, 5000)'),
        timeoutSeconds: 1
      },
      target: { type: 'local', cwd }
    })

    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(true)
    expect(result.error).toBe('Precheck timed out after 1s.')
  })

  it('aborts a local precheck process tree and settles promptly', async () => {
    const pidPath = join(cwd, 'child.pid')
    const controller = new AbortController()
    let childPid = 0
    try {
      const resultPromise = runAutomationPrecheck({
        precheck: {
          command: nodeCommand(
            `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000)`
          ),
          timeoutSeconds: 30
        },
        target: { type: 'local', cwd },
        signal: controller.signal
      })
      await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true))
      childPid = Number(readFileSync(pidPath, 'utf8'))

      controller.abort()

      await expect(resultPromise).resolves.toMatchObject({
        exitCode: null,
        timedOut: false,
        error: 'Precheck cancelled.'
      })
      await vi.waitFor(() => expect(isProcessAlive(childPid)).toBe(false))
    } finally {
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, 'SIGKILL')
      }
    }
  })

  it('uses the SSH channel exit event as the precheck exit code', async () => {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
      close: vi.fn()
    })
    sshManagerState.manager = {
      getConnection: vi.fn(() => ({
        getState: () => ({ status: 'connected' }),
        exec: vi.fn(async () => channel)
      }))
    }

    const resultPromise = runAutomationPrecheck({
      precheck: {
        command: "printf 'ready'",
        timeoutSeconds: 5
      },
      target: {
        type: 'ssh',
        cwd: '/repo/path',
        connectionId: 'ssh-1'
      }
    })
    await vi.waitFor(() => expect(channel.listenerCount('close')).toBe(1))
    channel.emit('data', Buffer.from('ready\n'))
    channel.emit('exit', 0)
    channel.emit('close')

    const result = await resultPromise
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('ready')
    expect(result.error).toBeNull()
  })

  it('closes an acquired SSH channel and settles when aborted', async () => {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
      close: vi.fn()
    })
    const exec = vi.fn(async () => channel)
    sshManagerState.manager = {
      getConnection: vi.fn(() => ({
        getState: () => ({ status: 'connected' }),
        exec
      }))
    }
    const controller = new AbortController()

    const resultPromise = runAutomationPrecheck({
      precheck: { command: 'long-command', timeoutSeconds: 30 },
      target: { type: 'ssh', cwd: '/repo/path', connectionId: 'ssh-1' },
      signal: controller.signal
    })
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: null,
      timedOut: false,
      error: 'Precheck cancelled.'
    })
    expect(channel.close).toHaveBeenCalledTimes(1)
    expect(channel.listenerCount('data')).toBe(0)
    expect(channel.listenerCount('close')).toBe(1)
    expect(channel.stderr.listenerCount('data')).toBe(0)
    expect(() => channel.emit('error', new Error('late channel error'))).not.toThrow()
    expect(() => channel.stderr.emit('error', new Error('late stderr error'))).not.toThrow()
    channel.emit('close')
    expect(channel.listenerCount('error')).toBe(0)
    expect(channel.stderr.listenerCount('error')).toBe(0)
  })

  it('bounds SSH channel acquisition and closes a channel that resolves after abort', async () => {
    let resolveExec!: (
      channel: EventEmitter & { stderr: PassThrough; close: ReturnType<typeof vi.fn> }
    ) => void
    const execPromise = new Promise<
      EventEmitter & { stderr: PassThrough; close: ReturnType<typeof vi.fn> }
    >((resolve) => {
      resolveExec = resolve
    })
    const exec = vi.fn(() => execPromise)
    sshManagerState.manager = {
      getConnection: vi.fn(() => ({
        getState: () => ({ status: 'connected' }),
        exec
      }))
    }
    const controller = new AbortController()
    const resultPromise = runAutomationPrecheck({
      precheck: { command: 'long-command', timeoutSeconds: 30 },
      target: { type: 'ssh', cwd: '/repo/path', connectionId: 'ssh-1' },
      signal: controller.signal
    })
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1))

    controller.abort()

    await expect(resultPromise).resolves.toMatchObject({ error: 'Precheck cancelled.' })
    const lateChannel = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
      close: vi.fn()
    })
    resolveExec(lateChannel)
    await vi.waitFor(() => expect(lateChannel.close).toHaveBeenCalledTimes(1))
    expect(() => lateChannel.emit('error', new Error('late channel error'))).not.toThrow()
    expect(() => lateChannel.stderr.emit('error', new Error('late stderr error'))).not.toThrow()
    lateChannel.emit('close')
    expect(lateChannel.listenerCount('error')).toBe(0)
    expect(lateChannel.stderr.listenerCount('error')).toBe(0)
  })

  it('consumes an SSH channel acquisition rejection after abort', async () => {
    let rejectExec!: (error: Error) => void
    const execPromise = new Promise<never>((_resolve, reject) => {
      rejectExec = reject
    })
    const exec = vi.fn(() => execPromise)
    sshManagerState.manager = {
      getConnection: vi.fn(() => ({
        getState: () => ({ status: 'connected' }),
        exec
      }))
    }
    const controller = new AbortController()
    const resultPromise = runAutomationPrecheck({
      precheck: { command: 'long-command', timeoutSeconds: 30 },
      target: { type: 'ssh', cwd: '/repo/path', connectionId: 'ssh-1' },
      signal: controller.signal
    })
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1))

    controller.abort()

    await expect(resultPromise).resolves.toMatchObject({ error: 'Precheck cancelled.' })
    rejectExec(new Error('late SSH acquisition failure'))
    await new Promise<void>((resolve) => setImmediate(resolve))
  })
})
