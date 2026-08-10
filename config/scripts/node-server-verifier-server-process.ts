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

export function startNodeServerVerifierProcess(args: {
  cliPath: string
  dataPath: string
}): Promise<NodeServerVerifierProcess> {
  return new Promise((resolveStart, rejectStart) => {
    const stderr: string[] = []
    const child = spawn(
      process.execPath,
      [
        args.cliPath,
        'serve',
        '--port',
        '0',
        '--listen',
        '127.0.0.1',
        '--pairing-address',
        '127.0.0.1',
        '--json'
      ],
      {
        env: { ...process.env, ORCA_SERVER_DATA_DIR: args.dataPath },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
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
