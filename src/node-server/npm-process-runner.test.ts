import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCapturedProcess } from './npm-process-runner'

const originalNpmExecPath = process.env.npm_execpath
const roots: string[] = []

afterEach(async () => {
  if (originalNpmExecPath === undefined) {
    delete process.env.npm_execpath
  } else {
    process.env.npm_execpath = originalNpmExecPath
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('npm process runner', () => {
  it('captures output and releases its parent-exit listener', async () => {
    const listenersBefore = process.listenerCount('exit')

    await expect(
      runCapturedProcess(
        process.execPath,
        ['-e', 'process.stdout.write("ready"); process.stderr.write("notice")'],
        5_000
      )
    ).resolves.toEqual({ code: 0, stdout: 'ready', stderr: 'notice' })

    expect(process.listenerCount('exit')).toBe(listenersBefore)
  })

  it('bounds captured output', async () => {
    const result = await runCapturedProcess(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(100000))'],
      5_000
    )

    expect(result.stdout).toHaveLength(64 * 1024)
  })

  it('times out and releases its parent-exit listener', async () => {
    const listenersBefore = process.listenerCount('exit')

    await expect(
      runCapturedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 25)
    ).rejects.toThrow('npm_process_timeout')

    expect(process.listenerCount('exit')).toBe(listenersBefore)
  })

  it('releases its parent-exit listener when spawn fails', async () => {
    const listenersBefore = process.listenerCount('exit')

    await expect(
      runCapturedProcess('orca-command-that-does-not-exist', [], 5_000)
    ).rejects.toBeDefined()

    expect(process.listenerCount('exit')).toBe(listenersBefore)
  })

  it('aborts and joins the spawned process tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-npm-process-'))
    roots.push(root)
    const pidPath = join(root, 'descendant.pid')
    const scriptPath = join(root, 'spawn-descendant.cjs')
    await writeFile(
      scriptPath,
      [
        "const { spawn } = require('node:child_process')",
        "const { writeFileSync } = require('node:fs')",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])",
        'writeFileSync(process.argv[2], String(child.pid))',
        'setInterval(() => {}, 1000)'
      ].join('\n')
    )
    const controller = new AbortController()
    const running = runCapturedProcess(
      process.execPath,
      [scriptPath, pidPath],
      5_000,
      controller.signal
    )
    await vi.waitFor(async () => expect(await readFile(pidPath, 'utf8')).toMatch(/^\d+$/))
    const descendantPid = Number(await readFile(pidPath, 'utf8'))

    controller.abort()

    await expect(running).rejects.toThrow('npm_process_aborted')
    await vi.waitFor(() => expect(isProcessAlive(descendantPid)).toBe(false))
  })
})

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
