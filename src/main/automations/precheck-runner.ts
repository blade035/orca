import { spawn, type ChildProcess } from 'node:child_process'
import type { AutomationPrecheck, AutomationPrecheckResult } from '../../shared/automations-types'
import {
  appendPrecheckTail,
  createPrecheckResult,
  failedPrecheckResult,
  PRECHECK_CANCELLED_ERROR,
  type PrecheckTailBuffer
} from './precheck-result'
import { runSshPrecheck } from './precheck-ssh-runner'

type AutomationPrecheckExecutionTarget =
  | {
      type: 'local'
      cwd: string
    }
  | {
      type: 'ssh'
      cwd: string
      connectionId: string
    }

function killLocalPrecheckProcessTree(
  child: ChildProcess,
  forceImmediately = false
): ReturnType<typeof setTimeout> | null {
  const pid = child.pid
  if (!pid) {
    child.kill()
    return null
  }

  if (process.platform === 'win32') {
    try {
      // Why: shell prechecks can launch child processes; taskkill walks the
      // Windows process tree so timeout means the command is actually stopped.
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      killer.on('error', () => child.kill())
      killer.unref()
    } catch {
      child.kill()
    }
    return null
  }

  try {
    process.kill(-pid, forceImmediately ? 'SIGKILL' : 'SIGTERM')
  } catch {
    child.kill(forceImmediately ? 'SIGKILL' : 'SIGTERM')
  }
  if (forceImmediately) {
    return null
  }

  const forceKillTimer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* process group already exited */
    }
  }, 2000)
  forceKillTimer.unref?.()
  return forceKillTimer
}

function observeLocalPrecheckTeardown(child: ChildProcess): void {
  const consumeError = (): void => {}
  const stopObserving = (): void => {
    child.off('error', consumeError)
  }
  child.on('error', consumeError)
  child.once('close', stopObserving)
}

function runLocalPrecheck(
  precheck: AutomationPrecheck,
  target: Extract<AutomationPrecheckExecutionTarget, { type: 'local' }>,
  signal?: AbortSignal
): Promise<AutomationPrecheckResult> {
  const startedAt = Date.now()
  if (signal?.aborted) {
    return Promise.resolve(failedPrecheckResult(precheck, startedAt, PRECHECK_CANCELLED_ERROR))
  }
  const timeoutMs = precheck.timeoutSeconds * 1000
  return new Promise((resolve) => {
    let stdout: PrecheckTailBuffer = { content: '', truncated: false }
    let stderr: PrecheckTailBuffer = { content: '', truncated: false }
    let timedOut = false
    let cancelled = false
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null

    const child = spawn(precheck.command, {
      cwd: target.cwd,
      detached: process.platform !== 'win32',
      env: process.env,
      shell: true,
      windowsHide: true
    })

    const collectStdout = (chunk: string): void => {
      stdout = appendPrecheckTail(stdout, chunk)
    }
    const collectStderr = (chunk: string): void => {
      stderr = appendPrecheckTail(stderr, chunk)
    }
    const onError = (error: Error): void => {
      settle(null, error.message)
    }
    const onClose = (code: number | null): void => {
      settle(
        timedOut || cancelled || typeof code !== 'number' ? null : code,
        cancelled
          ? PRECHECK_CANCELLED_ERROR
          : timedOut
            ? `Precheck timed out after ${precheck.timeoutSeconds}s.`
            : null
      )
    }
    const onAbort = (): void => {
      cancelled = true
      observeLocalPrecheckTeardown(child)
      forceKillTimer = killLocalPrecheckProcessTree(child, true)
      settle(null, PRECHECK_CANCELLED_ERROR)
    }
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
      child.stdout?.off('data', collectStdout)
      child.stderr?.off('data', collectStderr)
      child.off('error', onError)
      child.off('close', onClose)
    }
    const settle = (exitCode: number | null, error: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
        forceKillTimer = null
      }
      cleanup()
      resolve(
        createPrecheckResult({ precheck, startedAt, stdout, stderr, exitCode, timedOut, error })
      )
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', collectStdout)
    child.stderr?.on('data', collectStderr)
    child.on('error', onError)
    child.on('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    timeout = setTimeout(() => {
      timedOut = true
      forceKillTimer = killLocalPrecheckProcessTree(child)
    }, timeoutMs)
  })
}

export async function runAutomationPrecheck(args: {
  precheck: AutomationPrecheck
  target: AutomationPrecheckExecutionTarget
  signal?: AbortSignal
}): Promise<AutomationPrecheckResult> {
  if (args.target.type === 'ssh') {
    return await runSshPrecheck(args.precheck, args.target, args.signal)
  }
  return await runLocalPrecheck(args.precheck, args.target, args.signal)
}
