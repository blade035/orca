import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DaemonClient } from '../../src/main/daemon/client'
import { getDaemonSocketPath, getDaemonTokenPath } from '../../src/main/daemon/daemon-spawner'

export async function stopNodeServerVerifierDaemons(dataPath: string): Promise<void> {
  const daemonPath = join(dataPath, 'daemon')
  if (!existsSync(daemonPath)) {
    return
  }
  const shutdowns: Promise<void>[] = []
  for (const entry of readdirSync(daemonPath).sort()) {
    const match = /^daemon-v(\d+)\.pid$/.exec(entry)
    if (!match) {
      continue
    }
    try {
      const record = JSON.parse(readFileSync(join(daemonPath, entry), 'utf8')) as { pid?: unknown }
      if (typeof record.pid === 'number' && Number.isInteger(record.pid)) {
        shutdowns.push(shutdownDaemon(daemonPath, Number(match[1]), record.pid))
      }
    } catch {
      // The isolated verifier directory can contain a daemon that already retired.
    }
  }
  const results = await Promise.allSettled(shutdowns)
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Terminal daemon cleanup failed')
  }
}

async function shutdownDaemon(
  daemonPath: string,
  protocolVersion: number,
  pid: number
): Promise<void> {
  const client = new DaemonClient({
    socketPath: getDaemonSocketPath(daemonPath, protocolVersion),
    tokenPath: getDaemonTokenPath(daemonPath, protocolVersion),
    protocolVersion
  })
  let requestError: unknown
  try {
    await client.ensureConnectedWithin(5_000)
    const { sessions } = await client.request<{
      sessions: { sessionId: string; isAlive: boolean }[]
    }>('listSessions', undefined, 10_000)
    for (const session of sessions) {
      if (session.isAlive) {
        await client.request('kill', { sessionId: session.sessionId, immediate: true }, 10_000)
      }
    }
    await client.request('shutdown', { killSessions: true }, 10_000)
  } catch (error) {
    requestError = error
  } finally {
    client.disconnect()
  }

  try {
    await waitForProcessExit(pid)
  } catch (error) {
    if (requestError) {
      throw new AggregateError([requestError, error], `terminal daemon ${pid} cleanup failed`)
    }
    throw error
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`terminal daemon ${pid} did not exit after the shutdown request`)
}
