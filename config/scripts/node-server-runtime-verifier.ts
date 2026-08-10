import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeHostTree } from '../../src/main/host-tree-removal'
import { normalizeRuntimePathForComparison } from '../../src/shared/cross-platform-path'
import { decodePairingOffer, type PairingOffer } from '../../src/shared/pairing'
import { sendRemoteRuntimeRequest } from '../../src/shared/remote-runtime-client'
import type { RuntimeStatus, RuntimeTerminalRead } from '../../src/shared/runtime-types'
import { stopNodeServerVerifierDaemons } from './node-server-verifier-daemon-cleanup'

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

type RunningServer = { child: ChildProcess; ready: ReadyPayload; stderr: string[] }
const cliPath = resolve(readArgument('--cli') ?? 'resources/npm-server/dist/cli.js')
const shortTemporaryRoot = process.platform === 'win32' ? tmpdir() : '/tmp'
const ownedRoot = realpathSync(mkdtempSync(join(shortTemporaryRoot, 'orca-nsv-')))
const dataPath = join(ownedRoot, 'state')
const gitPath = join(ownedRoot, 'git-workspace')
const folderPath = join(ownedRoot, 'folder-workspace')

async function main(): Promise<void> {
  let activeServer: RunningServer | null = null
  try {
    execFileSync('git', ['init', gitPath], { stdio: 'ignore' })
    execFileSync(process.execPath, [
      '-e',
      `require('node:fs').mkdirSync(${JSON.stringify(folderPath)})`
    ])

    const first = await startServer()
    activeServer = first
    const pairing = decodePairingOffer(first.ready.pairing.url)
    await verifyWebClient(first.ready.pairing.webClientUrl)
    await verifyStatus(pairing, first.ready.runtimeId)
    await verifyBrowserUnavailable(pairing)
    await verifyGitWorkspace(pairing)
    const terminal = await verifyFolderWorkspaceAndTerminal(pairing)
    await stopServer(first)
    activeServer = null

    const second = await startServer()
    activeServer = second
    assert(
      second.ready.runtimeId !== first.ready.runtimeId,
      'runtime process identity did not rotate'
    )
    const reconnectedPairing = { ...pairing, endpoint: second.ready.boundEndpoint }
    await verifyStatus(reconnectedPairing, second.ready.runtimeId)
    const restored = await call<{ terminals: { handle: string; ptyId?: string }[] }>(
      reconnectedPairing,
      'terminal.list',
      { worktree: terminal.workspaceSelector }
    )
    assert(terminal.ptyId, 'created terminal did not expose its daemon identity')
    const reattached = restored.terminals.find((candidate) => candidate.ptyId === terminal.ptyId)
    assert(reattached, 'terminal daemon session was not adopted')
    await waitForTerminalMarker(reconnectedPairing, reattached.handle, terminal.marker)
    await stopServer(second)
    activeServer = null
    process.stdout.write('Node server runtime verification passed\n')
  } finally {
    if (activeServer?.child.exitCode === null) {
      await stopServer(activeServer).catch(() => activeServer?.child.kill('SIGKILL'))
    }
    await stopNodeServerVerifierDaemons(dataPath)
    await removeHostTree(ownedRoot)
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  )
  process.exitCode = 1
})

function readArgument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function startServer(): Promise<RunningServer> {
  return new Promise((resolveStart, rejectStart) => {
    const stderr: string[] = []
    const child = spawn(
      process.execPath,
      [
        cliPath,
        'serve',
        '--port',
        '0',
        '--listen',
        '127.0.0.1',
        '--pairing-address',
        '127.0.0.1',
        '--json'
      ],
      { env: { ...process.env, ORCA_SERVER_DATA_DIR: dataPath }, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = ''
    const timeout = setTimeout(() => fail(new Error('server readiness timed out')), 30_000)

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => stderr.push(chunk))
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      const newline = stdout.indexOf('\n')
      if (newline === -1) {
        return
      }
      try {
        const ready = JSON.parse(stdout.slice(0, newline)) as ReadyPayload
        assert(ready.type === 'orca_server_ready', 'unexpected readiness type')
        assert(ready.schemaVersion === 1, 'unexpected readiness schema')
        assert(ready.pairing.available, 'pairing unavailable')
        assert(new URL(ready.boundEndpoint).hostname === '127.0.0.1', 'listener is not loopback')
        clearTimeout(timeout)
        resolveStart({ child, ready, stderr })
      } catch (error) {
        fail(error)
      }
    })
    child.once('error', fail)
    child.once('exit', (code) =>
      fail(new Error(`server exited before readiness (${code}): ${stderr.join('')}`))
    )

    function fail(error: unknown): void {
      clearTimeout(timeout)
      if (child.exitCode === null) {
        child.kill('SIGTERM')
      }
      rejectStart(error)
    }
  })
}

async function stopServer(server: RunningServer): Promise<void> {
  const { child } = server
  if (child.exitCode !== null) {
    throw new Error(`server exited unexpectedly (${child.exitCode})`)
  }
  child.kill('SIGTERM')
  const result = await waitForServerExit(child)
  if (result.code !== 0) {
    throw new Error(
      `server shutdown failed (${result.code ?? result.signal}): ${server.stderr.join('')}`
    )
  }
}

function waitForServerExit(
  child: ChildProcess
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(
      () => rejectExit(new Error('server did not exit after SIGTERM')),
      10_000
    )
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolveExit({ code, signal })
    })
  })
}

async function verifyWebClient(url: string): Promise<void> {
  const response = await fetch(url)
  assert(response.ok, `web client returned ${response.status}`)
  assert((await response.text()).includes('<!doctype html>'), 'web client HTML was not served')
}

async function verifyStatus(pairing: PairingOffer, expectedRuntimeId: string): Promise<void> {
  const status = await call<RuntimeStatus>(pairing, 'status.get')
  assert(status.runtimeId === expectedRuntimeId, 'status returned the wrong runtime')
  assert(status.desktopWindowStatus === 'blocked', 'desktop status is not blocked')
  const capabilities = status.capabilities ?? []
  for (const capability of [
    'browser.screencast.v1',
    'browser.headless.v1',
    'browser.certificate-trust.v1'
  ]) {
    assert(!capabilities.includes(capability as never), `browser capability leaked: ${capability}`)
  }
}

async function verifyBrowserUnavailable(pairing: PairingOffer): Promise<void> {
  try {
    await call(pairing, 'browser.tabCreate', { url: 'about:blank' })
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('does not support browser panes'),
      'browser request did not fail with an unsupported-host error'
    )
    return
  }
  throw new Error('browser request unexpectedly succeeded')
}

async function verifyGitWorkspace(pairing: PairingOffer): Promise<void> {
  const added = await call<{ repo: { id: string } }>(pairing, 'repo.add', {
    path: gitPath,
    kind: 'git'
  })
  const listed = await call<{ worktrees: { id: string; path: string }[] }>(
    pairing,
    'worktree.list',
    { repo: `id:${added.repo.id}` }
  )
  assert(
    listed.worktrees.some((worktree) => isSameExistingHostPath(worktree.path, gitPath)),
    'Git worktree unavailable'
  )
}

function isSameExistingHostPath(left: string, right: string): boolean {
  try {
    return (
      normalizeRuntimePathForComparison(realpathSync.native(left)) ===
      normalizeRuntimePathForComparison(realpathSync.native(right))
    )
  } catch {
    return false
  }
}

async function verifyFolderWorkspaceAndTerminal(pairing: PairingOffer): Promise<{
  handle: string
  marker: string
  ptyId: string | undefined
  workspaceSelector: string
}> {
  const group = await call<{ group: { id: string } }>(pairing, 'projectGroup.create', {
    name: 'Package verification',
    parentPath: folderPath,
    createdFrom: 'manual'
  })
  const workspace = await call<{ folderWorkspace: { id: string } }>(
    pairing,
    'folderWorkspace.create',
    { projectGroupId: group.group.id, name: 'Folder workspace', folderPath }
  )
  const marker = `orca-node-server-${Date.now()}`
  const workspaceSelector = `id:folder:${workspace.folderWorkspace.id}`
  const created = await call<{ terminal: { handle: string; ptyId?: string } }>(
    pairing,
    'terminal.create',
    { worktree: workspaceSelector, command: `printf '${marker}\\n'` }
  )
  await waitForTerminalMarker(pairing, created.terminal.handle, marker)
  return {
    handle: created.terminal.handle,
    marker,
    ptyId: created.terminal.ptyId,
    workspaceSelector
  }
}

async function waitForTerminalMarker(
  pairing: PairingOffer,
  handle: string,
  marker: string
): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const result = await call<{ terminal: RuntimeTerminalRead }>(pairing, 'terminal.read', {
      terminal: handle,
      limit: 200
    })
    if (result.terminal.tail.join('\n').includes(marker)) {
      return
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error('terminal marker was not observed')
}

async function call<TResult>(
  pairing: PairingOffer,
  method: string,
  params?: unknown
): Promise<TResult> {
  const response = await sendRemoteRuntimeRequest<TResult>(pairing, method, params, 15_000)
  if (!response.ok) {
    throw new Error(`${method} failed: ${response.error.message}`)
  }
  return response.result
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}
