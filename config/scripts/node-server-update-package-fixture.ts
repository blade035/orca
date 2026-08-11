import type { ChildProcess } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type TerminalIdentity = {
  handle: string
  ptyId: string
  workspaceSelector: string
}

type ServerReadiness = {
  type: 'orca_server_ready'
  schemaVersion: 1
  runtimeId: string
  boundEndpoint: string
  pairing: { available: true; url: string }
}

export type DaemonIdentity = {
  file: string
  pid: number
  launchNonce: string | null
}

export type ReadinessObserver = {
  next: () => Promise<ServerReadiness>
  dispose: () => void
}

export function preseedPinnedRuntime(cliPath: string, dataPath: string, version: string): void {
  const sourcePackageRoot = resolve(dirname(cliPath), '..')
  const nestedNodeModules = join(sourcePackageRoot, 'node_modules')
  const sourceNodeModules = existsSync(nestedNodeModules)
    ? nestedNodeModules
    : resolve(sourcePackageRoot, '..', '..')
  const versionDirectory = pinnedVersionDirectory(dataPath, version)
  const destinationNodeModules = join(versionDirectory, 'node_modules')
  const destinationPackageRoot = join(destinationNodeModules, '@stablyai', 'orca')
  mkdirSync(versionDirectory, { recursive: true, mode: 0o700 })
  cpSync(sourceNodeModules, destinationNodeModules, { recursive: true, dereference: true })
  rmSync(destinationPackageRoot, { recursive: true, force: true })
  mkdirSync(dirname(destinationPackageRoot), { recursive: true })
  cpSync(sourcePackageRoot, destinationPackageRoot, {
    recursive: true,
    filter: (source) => source === sourcePackageRoot || !source.startsWith(nestedNodeModules)
  })
  rewritePinnedManifestVersion(dataPath, version, version)
  writeFileSync(join(versionDirectory, '.install-complete'), `${version}\n`, { mode: 0o600 })
}

export function rewritePinnedManifestVersion(
  dataPath: string,
  pinnedVersion: string,
  manifestVersion: string
): void {
  const manifestPath = pinnedPackageManifest(dataPath, pinnedVersion)
  const manifest = readJson<{ name?: unknown; version?: unknown }>(manifestPath)
  assert(manifest.name === '@stablyai/orca', 'candidate package manifest has the wrong name')
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...manifest, version: manifestVersion }, null, 2)}\n`
  )
}

export function makePinnedWorkerFailAfterPreflight(dataPath: string, version: string): void {
  const entryPath = join(
    pinnedVersionDirectory(dataPath, version),
    'node_modules',
    '@stablyai',
    'orca',
    'dist',
    'cli.js'
  )
  const delegatePath = join(dirname(entryPath), 'cli-worker-fixture.js')
  renameSync(entryPath, delegatePath)
  writeFileSync(
    entryPath,
    [
      '#!/usr/bin/env node',
      "if (process.argv[2] === '__orca-npm-worker') process.exit(19)",
      "require('./cli-worker-fixture.js')",
      ''
    ].join('\n')
  )
}

export function nextPatchVersion(version: string, increment: number): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  assert(match, `cannot synthesize an update version from ${version}`)
  return `${match[1]}.${match[2]}.${Number(match[3]) + increment}`
}

export function readDaemonIdentity(dataPath: string): DaemonIdentity {
  const daemonPath = join(dataPath, 'daemon')
  const identities = readdirSync(daemonPath)
    .filter((entry) => /^daemon-v\d+\.pid$/.test(entry))
    .map((file) => {
      const record = readJson<{ pid?: unknown; launchNonce?: unknown }>(join(daemonPath, file))
      return {
        file,
        pid: typeof record.pid === 'number' ? record.pid : Number.NaN,
        launchNonce: typeof record.launchNonce === 'string' ? record.launchNonce : null
      }
    })
    .filter((identity) => Number.isInteger(identity.pid) && isProcessAlive(identity.pid))
  assert(identities.length === 1, 'expected exactly one live terminal daemon identity')
  return identities[0]!
}

export function assertDaemonIdentity(dataPath: string, expected: DaemonIdentity): void {
  const actual = readDaemonIdentity(dataPath)
  assert(actual.file === expected.file, 'terminal daemon protocol identity changed')
  assert(actual.pid === expected.pid, 'terminal daemon PID changed during worker replacement')
  assert(actual.launchNonce === expected.launchNonce, 'terminal daemon launch identity changed')
}

export function observeReplacementReadiness(
  child: ChildProcess,
  dataPath: string,
  stderr: string[]
): ReadinessObserver {
  const queued: ServerReadiness[] = []
  const waiters: ((ready: ServerReadiness) => void)[] = []
  let buffered = ''
  const onStdout = (chunk: string): void => {
    buffered += chunk
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (line) {
        const ready = parseReadiness(line)
        const waiter = waiters.shift()
        if (waiter) {
          waiter(ready)
        } else {
          queued.push(ready)
        }
      }
      newline = buffered.indexOf('\n')
    }
  }
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', onStdout)
  return {
    next: () =>
      queued.length > 0
        ? Promise.resolve(queued.shift()!)
        : withTimeout(
            new Promise<ServerReadiness>((resolveReady) => waiters.push(resolveReady)),
            () => replacementTimeoutDetails(child, dataPath, stderr)
          ),
    dispose: () => child.stdout?.off('data', onStdout)
  }
}

function pinnedVersionDirectory(dataPath: string, version: string): string {
  return join(dataPath, 'npm-runtime', 'versions', version)
}

function pinnedPackageManifest(dataPath: string, version: string): string {
  return join(
    pinnedVersionDirectory(dataPath, version),
    'node_modules',
    '@stablyai',
    'orca',
    'package.json'
  )
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function parseReadiness(line: string): ServerReadiness {
  const value = JSON.parse(line) as Partial<ServerReadiness>
  assert(
    value.type === 'orca_server_ready' &&
      value.schemaVersion === 1 &&
      typeof value.runtimeId === 'string' &&
      typeof value.boundEndpoint === 'string' &&
      value.pairing?.available === true &&
      typeof value.pairing.url === 'string',
    'replacement emitted invalid readiness'
  )
  return value as ServerReadiness
}

function withTimeout<T>(promise: Promise<T>, details: () => string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`replacement readiness timed out: ${details()}`)),
        60_000
      )
    })
  ]).finally(() => {
    if (timeout) {
      clearTimeout(timeout)
    }
  })
}

function replacementTimeoutDetails(
  child: ChildProcess,
  dataPath: string,
  stderr: string[]
): string {
  const statePath = join(dataPath, 'npm-runtime', 'supervisor-state.json')
  const state = existsSync(statePath) ? readFileSync(statePath, 'utf8').trim() : 'missing'
  const errors = stderr.join('').trim().slice(-4_096) || 'none'
  return `supervisor=${child.exitCode ?? child.signalCode ?? 'running'} state=${state} stderr=${errors}`
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}
