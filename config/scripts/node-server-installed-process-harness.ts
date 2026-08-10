import { spawn, type ChildProcess } from 'node:child_process'

export type RunningInstalledServer = {
  child: ChildProcess
  readinessCount: number
  stderr: string[]
}

export type InstalledCliResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export type InstalledServerExitResult = {
  code: number | null
  signal: NodeJS.Signals | null
}

export function installedServeArguments(): string[] {
  return [
    'serve',
    '--port',
    '0',
    '--listen',
    '127.0.0.1',
    '--pairing-address',
    '127.0.0.1',
    '--json'
  ]
}

export function startInstalledServer(
  cliPath: string,
  dataPath: string,
  args: string[]
): Promise<RunningInstalledServer> {
  return new Promise((resolveStart, rejectStart) => {
    const server: RunningInstalledServer = {
      child: spawn(process.execPath, [cliPath, ...args], {
        env: installedProfileEnvironment(dataPath),
        stdio: ['ignore', 'pipe', 'pipe']
      }),
      readinessCount: 0,
      stderr: []
    }
    let stdout = ''
    let settled = false
    const timeout = setTimeout(
      () => fail(new Error('installed server readiness timed out')),
      30_000
    )

    server.child.stderr?.setEncoding('utf8')
    server.child.stderr?.on('data', (chunk: string) => server.stderr.push(chunk))
    server.child.stdout?.setEncoding('utf8')
    server.child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      const lines = stdout.split('\n')
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        if (isReadinessLine(line)) {
          server.readinessCount += 1
          if (!settled) {
            settled = true
            clearTimeout(timeout)
            resolveStart(server)
          }
        }
      }
    })
    server.child.once('error', fail)
    server.child.once('exit', (code, signal) => {
      if (!settled) {
        fail(new Error(`installed server exited before readiness (${code ?? signal})`))
      }
    })

    function fail(error: unknown): void {
      clearTimeout(timeout)
      if (server.child.exitCode === null && server.child.signalCode === null) {
        server.child.kill('SIGKILL')
      }
      if (!settled) {
        settled = true
        rejectStart(error)
      }
    }
  })
}

export async function stopInstalledServer(server: RunningInstalledServer): Promise<void> {
  if (server.child.exitCode !== null || server.child.signalCode !== null) {
    throw new Error('installed server exited unexpectedly')
  }
  if (!server.child.kill('SIGTERM')) {
    throw new Error('installed server rejected the shutdown signal')
  }
  const result = await waitForInstalledServerExit(server.child)
  if (!isExpectedInstalledServerStopResult(result, process.platform)) {
    throw new Error(`installed server shutdown failed (${formatInstalledExit(result)})`)
  }
}

export function isExpectedInstalledServerStopResult(
  result: InstalledServerExitResult,
  platform: NodeJS.Platform
): boolean {
  return platform === 'win32'
    ? result.code === null && result.signal === 'SIGTERM'
    : result.code === 0 && result.signal === null
}

export async function terminateInstalledServer(
  server: RunningInstalledServer | null
): Promise<void> {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) {
    return
  }
  server.child.kill('SIGKILL')
  await waitForInstalledServerExit(server.child).catch(() => undefined)
}

export function waitForInstalledServerExit(
  child: ChildProcess
): Promise<InstalledServerExitResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error('installed server did not exit')), 10_000)
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolveExit({ code, signal })
    })
  })
}

export async function runInstalledCliJson<TResult>(
  options: { cliPath: string; dataPath: string },
  args: string[]
): Promise<TResult> {
  const result = await runInstalledCli(options.cliPath, options.dataPath, args)
  assertInstalledCliSuccess(result, args.join(' '))
  try {
    return JSON.parse(result.stdout) as TResult
  } catch {
    throw new Error(`${args.join(' ')} returned invalid JSON: ${result.stdout}`)
  }
}

export function runInstalledCli(
  cliPath: string,
  dataPath: string,
  args: string[]
): Promise<InstalledCliResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: installedProfileEnvironment(dataPath),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      rejectRun(new Error(`${args.join(' ')} timed out`))
    }, 30_000)
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectRun(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolveRun({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      })
    })
  })
}

export function installedReadinessEvents(stdout: string): number {
  return stdout.split('\n').filter(isReadinessLine).length
}

export function assertSingleInstalledReadiness(
  server: RunningInstalledServer,
  label: string
): void {
  if (server.readinessCount !== 1) {
    throw new Error(`${label} emitted ${server.readinessCount} readiness events`)
  }
}

export function assertInstalledCliSuccess(result: InstalledCliResult, label: string): void {
  if (result.code !== 0) {
    throw new Error(`${label} failed (${formatInstalledExit(result)}): ${result.stderr}`)
  }
}

export function formatInstalledExit(result: InstalledServerExitResult): string {
  return result.code === null ? (result.signal ?? 'unknown') : String(result.code)
}

function installedProfileEnvironment(dataPath: string): NodeJS.ProcessEnv {
  const env = { ...process.env, ORCA_SERVER_DATA_DIR: dataPath }
  delete env.ORCA_USER_DATA_PATH
  delete env.ORCA_PAIRING_CODE
  delete env.ORCA_REMOTE_PAIRING
  delete env.ORCA_ENVIRONMENT
  return env
}

function isReadinessLine(line: string): boolean {
  if (line === 'Orca server ready') {
    return true
  }
  try {
    return (JSON.parse(line) as { type?: unknown }).type === 'orca_server_ready'
  } catch {
    return false
  }
}
