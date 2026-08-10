import { spawn, type ChildProcess } from 'node:child_process'
import {
  isExpectedInstalledServerStopResult,
  waitForInstalledServerExit
} from './node-server-installed-process-harness'

type ReadyPayload = {
  type: 'orca_server_ready'
  schemaVersion: 1
  runtimeId: string
  boundEndpoint: string
  pairing: {
    available: true
    url: string
    webClientUrl: string
  }
}

export type NodeServerVerifierProcess = {
  child: ChildProcess
  ready: ReadyPayload
  stderr: string[]
}

export async function verifyNodeServerStartupCancellation(args: {
  cliPath: string
  dataPath: string
}): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  const child = spawn(process.execPath, serverArguments(args.cliPath), {
    env: {
      ...process.env,
      ORCA_E2E_DAEMON_INIT_DELAY_MS: '30000',
      ORCA_SERVER_DATA_DIR: args.dataPath,
      ORCA_STARTUP_DIAGNOSTICS: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })

  try {
    await waitForDaemonInitMarker(child, () => stderr)
    if (!child.kill('SIGTERM')) {
      throw new Error('server rejected the startup shutdown signal')
    }
    const result = await waitForInstalledServerExit(child)
    if (!isExpectedInstalledServerStopResult(result, process.platform)) {
      throw new Error(`server startup shutdown failed (${result.code ?? result.signal}): ${stderr}`)
    }
    if (stdout.length > 0) {
      throw new Error(`server published readiness during startup shutdown: ${stdout}`)
    }
  } finally {
    await terminateNodeServerVerifierProcess(child)
  }
}

export function startNodeServerVerifierProcess(args: {
  cliPath: string
  dataPath: string
}): Promise<NodeServerVerifierProcess> {
  return new Promise((resolveStart, rejectStart) => {
    const stderr: string[] = []
    const child = spawn(process.execPath, serverArguments(args.cliPath), {
      env: { ...process.env, ORCA_SERVER_DATA_DIR: args.dataPath },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let settled = false
    const timeout = setTimeout(() => fail(new Error('server readiness timed out')), 30_000)

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => stderr.push(chunk))
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', onStdout)
    child.once('error', fail)
    child.once('exit', onEarlyExit)

    function onStdout(chunk: string): void {
      stdout += chunk
      const newline = stdout.indexOf('\n')
      if (newline === -1) {
        return
      }
      try {
        const ready = JSON.parse(stdout.slice(0, newline)) as ReadyPayload
        assertReadyPayload(ready)
        settled = true
        stopObservingReadiness()
        child.on('error', observeRuntimeError)
        resolveStart({ child, ready, stderr })
      } catch (error) {
        fail(error)
      }
    }

    function onEarlyExit(code: number | null): void {
      fail(new Error(`server exited before readiness (${code}): ${stderr.join('')}`))
    }

    function observeRuntimeError(error: Error): void {
      stderr.push(`${error.stack ?? error.message}\n`)
    }

    function stopObservingReadiness(): void {
      clearTimeout(timeout)
      child.stdout?.off('data', onStdout)
      child.off('error', fail)
      child.off('exit', onEarlyExit)
    }

    function fail(error: unknown): void {
      if (settled) {
        return
      }
      settled = true
      stopObservingReadiness()
      void terminateNodeServerVerifierProcess(child).then(
        () => rejectStart(error),
        (terminationError) =>
          rejectStart(
            new AggregateError([error, terminationError], 'server readiness cleanup failed')
          )
      )
    }
  })
}

function serverArguments(cliPath: string): string[] {
  return [
    cliPath,
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

function waitForDaemonInitMarker(child: ChildProcess, readStderr: () => string): Promise<void> {
  return new Promise((resolveMarker, rejectMarker) => {
    const timeout = setTimeout(
      () => finish(new Error(`daemon init marker timed out: ${readStderr()}`)),
      10_000
    )
    child.stderr?.on('data', onStderr)
    child.once('error', finish)
    child.once('exit', onExit)

    function onStderr(): void {
      if (readStderr().includes('[startup] daemon-init-start')) {
        finish()
      }
    }

    function onExit(code: number | null): void {
      finish(new Error(`server exited before daemon init marker (${code}): ${readStderr()}`))
    }

    function finish(error?: unknown): void {
      clearTimeout(timeout)
      child.stderr?.off('data', onStderr)
      child.off('error', finish)
      child.off('exit', onExit)
      if (error) {
        rejectMarker(error)
      } else {
        resolveMarker()
      }
    }
  })
}

export async function terminateNodeServerVerifierProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  if (!child.kill('SIGKILL')) {
    throw new Error('server rejected forced termination')
  }
  await waitForInstalledServerExit(child)
}

export async function stopNodeServerVerifierProcess(
  server: NodeServerVerifierProcess
): Promise<void> {
  const { child } = server
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`server exited unexpectedly (${child.exitCode ?? child.signalCode})`)
  }
  if (!child.kill('SIGTERM')) {
    throw new Error('server rejected the shutdown signal')
  }
  const result = await waitForInstalledServerExit(child)
  if (!isExpectedInstalledServerStopResult(result, process.platform)) {
    throw new Error(
      `server shutdown failed (${result.code ?? result.signal}): ${server.stderr.join('')}`
    )
  }
}

function assertReadyPayload(ready: ReadyPayload): void {
  if (
    ready.type !== 'orca_server_ready' ||
    ready.schemaVersion !== 1 ||
    !ready.pairing.available ||
    new URL(ready.boundEndpoint).hostname !== '127.0.0.1'
  ) {
    throw new Error('server returned invalid readiness data')
  }
}
