import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION as DAEMON_PROTOCOL_VERSION } from '../main/daemon/daemon-protocol-version'
import { getNpmRuntimeEntryPath, getNpmRuntimeVersionDirectory } from './npm-runtime-paths'
import {
  ensurePinnedNpmRuntime,
  preflightPinnedNpmRuntime,
  verifyPinnedNpmRuntime
} from './npm-pinned-runtime'

const roots: string[] = []
const mocks = vi.hoisted(() => ({
  runCaptured: vi.fn(),
  runNpm: vi.fn()
}))

vi.mock('./npm-process-runner', () => ({
  runCapturedProcess: mocks.runCaptured,
  runNpmCommand: mocks.runNpm
}))

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.runCaptured.mockResolvedValue({
    code: 0,
    stdout: JSON.stringify({
      ready: true,
      version: '1.5.0',
      daemonProtocolVersion: DAEMON_PROTOCOL_VERSION,
      supervisorProtocolVersion: 1
    }),
    stderr: ''
  })
  mocks.runNpm.mockImplementation(async (args: string[]) => {
    const prefixIndex = args.indexOf('--prefix')
    const stagingDirectory = args[prefixIndex + 1]
    if (!stagingDirectory) {
      throw new Error('test staging directory missing')
    }
    const entry = join(stagingDirectory, 'node_modules', '@stablyai', 'orca', 'dist', 'cli.js')
    await mkdir(join(entry, '..'), { recursive: true })
    await writeFile(entry, 'fixture')
    return { code: 0, stdout: '', stderr: '' }
  })
})

describe('pinned npm runtime', () => {
  it('publishes only a preflighted exact version and reuses the immutable result', async () => {
    const root = await createRoot()

    const first = await ensurePinnedNpmRuntime(root, '1.5.0')
    const second = await ensurePinnedNpmRuntime(root, '1.5.0')

    expect(first).toBe(getNpmRuntimeEntryPath(root, '1.5.0'))
    expect(second).toBe(first)
    expect(await verifyPinnedNpmRuntime(root, '1.5.0')).toBe(first)
    expect(mocks.runNpm).toHaveBeenCalledOnce()
    expect(mocks.runCaptured).toHaveBeenCalledTimes(2)
  })

  it('removes incomplete target and staging directories before retrying', async () => {
    const root = await createRoot()
    const target = getNpmRuntimeVersionDirectory(root, '1.5.0')
    const stale = join(target, '..', '.staging-crashed')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'partial'), 'partial')
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, 'partial'), 'partial')

    await expect(ensurePinnedNpmRuntime(root, '1.5.0')).resolves.toBe(
      getNpmRuntimeEntryPath(root, '1.5.0')
    )
    expect(await verifyPinnedNpmRuntime(root, '1.5.0')).not.toBeNull()
  })

  it('rejects tags and ranges before invoking npm', async () => {
    const root = await createRoot()

    await expect(ensurePinnedNpmRuntime(root, 'latest')).rejects.toThrow(
      'npm_update_invalid_exact_version'
    )
    expect(mocks.runNpm).not.toHaveBeenCalled()
  })

  it('rechecks candidate preflight immediately before activation', async () => {
    const root = await createRoot()
    await ensurePinnedNpmRuntime(root, '1.5.0')
    mocks.runCaptured.mockClear()

    await expect(preflightPinnedNpmRuntime(root, '1.5.0')).resolves.toBe(
      getNpmRuntimeEntryPath(root, '1.5.0')
    )

    expect(mocks.runCaptured).toHaveBeenCalledOnce()
  })

  it('does not delete a complete runtime when preflight is cancelled', async () => {
    const root = await createRoot()
    await ensurePinnedNpmRuntime(root, '1.5.0')
    mocks.runCaptured.mockRejectedValueOnce(new Error('npm_process_aborted'))

    await expect(ensurePinnedNpmRuntime(root, '1.5.0')).rejects.toThrow('npm_process_aborted')

    expect(await verifyPinnedNpmRuntime(root, '1.5.0')).not.toBeNull()
    expect(mocks.runNpm).toHaveBeenCalledOnce()
  })
})

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-pinned-npm-'))
  roots.push(root)
  return root
}
