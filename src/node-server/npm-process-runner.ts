import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MAX_CAPTURED_OUTPUT = 64 * 1024

export type NpmProcessResult = {
  code: number
  stdout: string
  stderr: string
}

export function resolveNpmCommand(): { command: string; prefixArgs: string[] } {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath && /(?:^|[\\/])npm-cli\.js$/i.test(npmExecPath) && existsSync(npmExecPath)) {
    return { command: process.execPath, prefixArgs: [npmExecPath] }
  }
  if (process.platform === 'win32') {
    const npmCliPath = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (!existsSync(npmCliPath)) {
      throw new Error('npm_cli_unavailable')
    }
    return { command: process.execPath, prefixArgs: [npmCliPath] }
  }
  return { command: 'npm', prefixArgs: [] }
}

export function runNpmCommand(
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<NpmProcessResult> {
  const npm = resolveNpmCommand()
  return runCapturedProcess(npm.command, [...npm.prefixArgs, ...args], timeoutMs, signal)
}

export function runCapturedProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<NpmProcessResult> {
  if (signal?.aborted) {
    return Promise.reject(new Error('npm_process_aborted'))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let termination: Promise<void> | null = null
    let settled = false
    const killOnParentExit = (): void => {
      terminateNpmProcessTreeSync(child)
    }
    const abort = (): void => {
      aborted = true
      termination ??= terminateNpmProcessTree(child)
    }
    const timer = setTimeout(() => {
      timedOut = true
      termination ??= terminateNpmProcessTree(child)
    }, timeoutMs)
    process.once('exit', killOnParentExit)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = appendBounded(stdout, chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = appendBounded(stderr, chunk)
    })
    child.once('error', (error) => {
      settled = true
      void (termination ?? Promise.resolve()).then(
        () => {
          cleanup()
          reject(aborted ? new Error('npm_process_aborted') : error)
        },
        (terminationError) => {
          cleanup()
          reject(terminationError)
        }
      )
    })
    child.once('exit', (code, exitSignal) => {
      if (settled) {
        return
      }
      void (termination ?? Promise.resolve()).then(
        () => {
          cleanup()
          if (timedOut) {
            reject(new Error('npm_process_timeout'))
          } else if (aborted) {
            reject(new Error('npm_process_aborted'))
          } else if (exitSignal) {
            reject(new Error(`npm_process_signal:${exitSignal}`))
          } else {
            resolve({ code: code ?? 1, stdout, stderr })
          }
        },
        (error) => {
          cleanup()
          reject(error)
        }
      )
    })

    function cleanup(): void {
      clearTimeout(timer)
      process.off('exit', killOnParentExit)
      signal?.removeEventListener('abort', abort)
    }
  })
}

function terminateNpmProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!pid) {
    child.kill('SIGKILL')
    return Promise.resolve()
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
    killer.once('error', () => {
      child.kill('SIGKILL')
      resolve()
    })
    killer.once('exit', () => resolve())
  })
}

function terminateNpmProcessTreeSync(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) {
    return
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

function appendBounded(current: string, chunk: string): string {
  if (current.length >= MAX_CAPTURED_OUTPUT) {
    return current
  }
  return `${current}${chunk}`.slice(0, MAX_CAPTURED_OUTPUT)
}
