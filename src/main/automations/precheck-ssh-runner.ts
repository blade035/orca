import type { ClientChannel } from 'ssh2'
import type { AutomationPrecheck, AutomationPrecheckResult } from '../../shared/automations-types'
import { getSshConnectionManager } from '../ipc/ssh'
import { shellEscape } from '../ssh/ssh-connection-utils'
import {
  appendPrecheckTail,
  createPrecheckResult,
  failedPrecheckResult,
  PRECHECK_CANCELLED_ERROR,
  type PrecheckTailBuffer
} from './precheck-result'

type SshPrecheckTarget = {
  cwd: string
  connectionId: string
}

function consumeLateSshErrors(channel: ClientChannel, alreadyClosed: boolean): void {
  const consumeError = (): void => {}
  const stopObserving = (): void => {
    channel.off('error', consumeError)
    channel.stderr.off('error', consumeError)
    channel.off('close', stopObserving)
  }
  channel.on('error', consumeError)
  channel.stderr.on('error', consumeError)
  if (alreadyClosed) {
    setImmediate(stopObserving)
  } else {
    channel.once('close', stopObserving)
  }
}

function closeSshPrecheckChannel(channel: ClientChannel): void {
  const consumeError = (): void => {}
  const stopObserving = (): void => {
    channel.off('error', consumeError)
    channel.stderr.off('error', consumeError)
  }
  channel.on('error', consumeError)
  channel.stderr.on('error', consumeError)
  channel.once('close', stopObserving)
  try {
    channel.close()
  } catch {}
  try {
    channel.destroy()
  } catch {
    stopObserving()
  }
}

function runSshChannelPrecheck(args: {
  precheck: AutomationPrecheck
  channel: ClientChannel
  startedAt: number
  timeoutMs: number
  signal?: AbortSignal
}): Promise<AutomationPrecheckResult> {
  const { precheck, channel, startedAt, timeoutMs, signal } = args
  if (signal?.aborted) {
    closeSshPrecheckChannel(channel)
    return Promise.resolve(failedPrecheckResult(precheck, startedAt, PRECHECK_CANCELLED_ERROR))
  }
  return new Promise((resolve) => {
    let stdout: PrecheckTailBuffer = { content: '', truncated: false }
    let stderr: PrecheckTailBuffer = { content: '', truncated: false }
    let exitCode: number | null = null
    let timedOut = false
    let cancelled = false
    let closed = false
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    const collectStdout = (data: Buffer | string): void => {
      stdout = appendPrecheckTail(stdout, data.toString())
    }
    const collectStderr = (data: Buffer | string): void => {
      stderr = appendPrecheckTail(stderr, data.toString())
    }
    const fail = (error: Error): void => {
      settle(null, error.message)
    }
    const onExit = (code: number | null): void => {
      exitCode = typeof code === 'number' ? code : null
    }
    const onClose = (code?: number | null): void => {
      closed = true
      if (typeof code === 'number') {
        exitCode = code
      }
      settle(
        cancelled ? null : exitCode,
        cancelled
          ? PRECHECK_CANCELLED_ERROR
          : timedOut
            ? `Precheck timed out after ${precheck.timeoutSeconds}s.`
            : null
      )
    }
    const onAbort = (): void => {
      cancelled = true
      settle(null, PRECHECK_CANCELLED_ERROR)
      closeSshPrecheckChannel(channel)
    }
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
      channel.off('error', fail)
      channel.stderr.off('error', fail)
      channel.off('data', collectStdout)
      channel.stderr.off('data', collectStderr)
      channel.off('exit', onExit)
      channel.off('close', onClose)
      if (!cancelled && !timedOut) {
        consumeLateSshErrors(channel, closed)
      }
    }
    const settle = (resultExitCode: number | null, error: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      cleanup()
      resolve(
        createPrecheckResult({
          precheck,
          startedAt,
          stdout,
          stderr,
          exitCode: resultExitCode,
          timedOut,
          error
        })
      )
    }

    timeout = setTimeout(() => {
      timedOut = true
      settle(null, `Precheck timed out after ${precheck.timeoutSeconds}s.`)
      closeSshPrecheckChannel(channel)
    }, timeoutMs)
    channel.on('error', fail)
    channel.stderr.on('error', fail)
    channel.on('data', collectStdout)
    channel.stderr.on('data', collectStderr)
    channel.on('exit', onExit)
    channel.on('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }
  })
}

type SshChannelAcquisition = { channel: ClientChannel } | { aborted: true } | { timedOut: true }

function acquireSshPrecheckChannel(
  channelPromise: Promise<ClientChannel>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<SshChannelAcquisition> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const finish = (result: SshChannelAcquisition): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
      }
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = (): void => {
      finish({ aborted: true })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(() => finish({ timedOut: true }), timeoutMs)
    channelPromise.then(
      (channel) => {
        if (settled) {
          closeSshPrecheckChannel(channel)
          return
        }
        finish({ channel })
      },
      (error: unknown) => {
        if (settled) {
          return
        }
        settled = true
        if (timeout) {
          clearTimeout(timeout)
        }
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
    if (signal?.aborted) {
      onAbort()
    }
  })
}

function timedOutSshPrecheck(
  precheck: AutomationPrecheck,
  startedAt: number
): AutomationPrecheckResult {
  return createPrecheckResult({
    precheck,
    startedAt,
    stdout: { content: '', truncated: false },
    stderr: { content: '', truncated: false },
    exitCode: null,
    timedOut: true,
    error: `Precheck timed out after ${precheck.timeoutSeconds}s.`
  })
}

export async function runSshPrecheck(
  precheck: AutomationPrecheck,
  target: SshPrecheckTarget,
  signal?: AbortSignal
): Promise<AutomationPrecheckResult> {
  const startedAt = Date.now()
  if (signal?.aborted) {
    return failedPrecheckResult(precheck, startedAt, PRECHECK_CANCELLED_ERROR)
  }
  const manager = getSshConnectionManager()
  const connection = manager?.getConnection(target.connectionId)
  if (!connection || connection.getState().status !== 'connected') {
    return failedPrecheckResult(precheck, startedAt, 'SSH target is not connected.')
  }
  try {
    const timeoutMs = precheck.timeoutSeconds * 1000
    const deadline = startedAt + timeoutMs
    const remoteCommand = `cd ${shellEscape(target.cwd)} && ${precheck.command}`
    const channelPromise = connection.exec(remoteCommand)
    const acquisition = await acquireSshPrecheckChannel(channelPromise, timeoutMs, signal)
    if ('aborted' in acquisition) {
      return failedPrecheckResult(precheck, startedAt, PRECHECK_CANCELLED_ERROR)
    }
    if ('timedOut' in acquisition) {
      return timedOutSshPrecheck(precheck, startedAt)
    }
    return await runSshChannelPrecheck({
      precheck,
      channel: acquisition.channel,
      startedAt,
      timeoutMs: Math.max(0, deadline - Date.now()),
      ...(signal ? { signal } : {})
    })
  } catch (error) {
    return failedPrecheckResult(
      precheck,
      startedAt,
      error instanceof Error ? error.message : String(error)
    )
  }
}
