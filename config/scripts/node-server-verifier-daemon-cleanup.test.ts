import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const clientState = vi.hoisted(() => ({ requests: [] as string[] }))

vi.mock('../../src/main/daemon/client', () => ({
  DaemonClient: class {
    async ensureConnectedWithin(): Promise<void> {}

    async request(method: string): Promise<unknown> {
      clientState.requests.push(method)
      return method === 'listSessions' ? { sessions: [] } : undefined
    }

    disconnect(): void {}
  }
}))

import { stopNodeServerVerifierDaemons } from './node-server-verifier-daemon-cleanup'

const temporaryPaths: string[] = []

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  clientState.requests.length = 0
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('stopNodeServerVerifierDaemons', () => {
  it('waits for every shutdown attempt before aggregating cleanup failures', async () => {
    vi.useFakeTimers()
    const dataPath = mkdtempSync(join(tmpdir(), 'orca-daemon-cleanup-'))
    temporaryPaths.push(dataPath)
    const daemonPath = join(dataPath, 'daemon')
    mkdirSync(daemonPath)
    writeFileSync(join(daemonPath, 'daemon-v4.pid'), JSON.stringify({ pid: 4101 }))
    writeFileSync(join(daemonPath, 'daemon-v5.pid'), JSON.stringify({ pid: 5101 }))
    vi.spyOn(process, 'kill').mockImplementation(() => true)

    const outcome = stopNodeServerVerifierDaemons(dataPath).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10_100)

    const error = await outcome
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(2)
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: 'terminal daemon 4101 did not exit after the shutdown request'
      }),
      expect.objectContaining({
        message: 'terminal daemon 5101 did not exit after the shutdown request'
      })
    ])
    expect(clientState.requests.filter((method) => method === 'shutdown')).toHaveLength(2)
  })
})
