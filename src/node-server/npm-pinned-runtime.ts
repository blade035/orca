import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  getNpmRuntimeEntryPath,
  getNpmRuntimeSentinelPath,
  getNpmRuntimeVersionDirectory
} from './npm-runtime-paths'
import { runCapturedProcess, runNpmCommand } from './npm-process-runner'
import {
  NPM_PREFLIGHT_COMMAND,
  NPM_SUPERVISOR_PROTOCOL_VERSION,
  isExactNpmVersion
} from './npm-supervisor-protocol'
import { PROTOCOL_VERSION as DAEMON_PROTOCOL_VERSION } from '../main/daemon/daemon-protocol-version'
import {
  classifyNpmCommandFailure,
  classifyNpmPreflightFailure
} from './npm-update-error-classification'

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
const PREFLIGHT_TIMEOUT_MS = 60 * 1000

export async function ensurePinnedNpmRuntime(
  dataPath: string,
  version: string,
  signal?: AbortSignal
): Promise<string> {
  if (!isExactNpmVersion(version)) {
    throw new Error('npm_update_invalid_exact_version')
  }
  throwIfNpmUpdateAborted(signal)
  const existing = await verifyPinnedNpmRuntime(dataPath, version)
  if (existing) {
    try {
      await runPinnedRuntimePreflight(existing, version, signal)
      return existing
    } catch (error) {
      if (!shouldDiscardPinnedRuntime(error)) {
        throw error
      }
      await rm(getNpmRuntimeVersionDirectory(dataPath, version), {
        recursive: true,
        force: true
      })
    }
  }

  const versionDirectory = getNpmRuntimeVersionDirectory(dataPath, version)
  const versionsDirectory = dirname(versionDirectory)
  await mkdir(versionsDirectory, { recursive: true, mode: 0o700 })
  await removeIncompleteStagingDirectories(versionsDirectory)
  await rm(versionDirectory, { recursive: true, force: true })
  const stagingDirectory = await mkdtemp(join(versionsDirectory, '.staging-'))
  try {
    const result = await runNpmCommand(
      [
        'install',
        '--prefix',
        stagingDirectory,
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        '--no-save',
        `@stablyai/orca@${version}`
      ],
      INSTALL_TIMEOUT_MS,
      signal
    )
    if (result.code !== 0) {
      throw new Error(classifyNpmCommandFailure(result.stderr, 'install'))
    }
    const stagingEntry = join(
      stagingDirectory,
      'node_modules',
      '@stablyai',
      'orca',
      'dist',
      'cli.js'
    )
    throwIfNpmUpdateAborted(signal)
    await runPinnedRuntimePreflight(stagingEntry, version, signal)
    await writeFile(join(stagingDirectory, '.install-complete'), `${version}\n`, { mode: 0o600 })
    await rename(stagingDirectory, versionDirectory).catch(async (error: unknown) => {
      if (!(await verifyPinnedNpmRuntime(dataPath, version))) {
        throw error
      }
    })
    const published = await verifyPinnedNpmRuntime(dataPath, version)
    if (!published) {
      throw new Error('npm_update_publish_incomplete')
    }
    return published
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function removeIncompleteStagingDirectories(versionsDirectory: string): Promise<void> {
  const entries = await readdir(versionsDirectory)
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith('.staging-'))
      .map((entry) => rm(join(versionsDirectory, entry), { recursive: true, force: true }))
  )
}

export async function verifyPinnedNpmRuntime(
  dataPath: string,
  version: string
): Promise<string | null> {
  if (!isExactNpmVersion(version)) {
    return null
  }
  const entryPath = getNpmRuntimeEntryPath(dataPath, version)
  const sentinelPath = getNpmRuntimeSentinelPath(dataPath, version)
  if (!existsSync(entryPath)) {
    return null
  }
  try {
    return (await readFile(sentinelPath, 'utf8')).trim() === version ? entryPath : null
  } catch {
    return null
  }
}

export async function preflightPinnedNpmRuntime(
  dataPath: string,
  version: string,
  signal?: AbortSignal
): Promise<string | null> {
  const entryPath = await verifyPinnedNpmRuntime(dataPath, version)
  if (!entryPath) {
    return null
  }
  await runPinnedRuntimePreflight(entryPath, version, signal)
  return entryPath
}

async function runPinnedRuntimePreflight(
  entryPath: string,
  version: string,
  signal?: AbortSignal
): Promise<void> {
  const result = await runCapturedProcess(
    process.execPath,
    [entryPath, NPM_PREFLIGHT_COMMAND, '--expected-version', version],
    PREFLIGHT_TIMEOUT_MS,
    signal
  )
  if (result.code !== 0) {
    throw new Error(classifyNpmPreflightFailure(result.stderr))
  }
  try {
    const payload = JSON.parse(result.stdout.trim()) as {
      daemonProtocolVersion?: number
      ready?: boolean
      version?: string
      supervisorProtocolVersion?: number
    }
    if (payload.ready !== true) {
      throw new Error('npm_update_preflight_not_ready')
    }
    if (payload.version !== version) {
      throw new Error('npm_update_preflight_version_mismatch')
    }
    if (payload.supervisorProtocolVersion !== NPM_SUPERVISOR_PROTOCOL_VERSION) {
      throw new Error('npm_update_supervisor_relaunch_required')
    }
    if (payload.daemonProtocolVersion !== DAEMON_PROTOCOL_VERSION) {
      throw new Error('npm_update_daemon_relaunch_required')
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('npm_update_')) {
      throw error
    }
    throw new Error('npm_update_preflight_invalid')
  }
}

function throwIfNpmUpdateAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('npm_process_aborted')
  }
}

function shouldDiscardPinnedRuntime(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return [
    'npm_update_native_load_failed',
    'npm_update_package_identity_mismatch',
    'npm_update_package_incomplete',
    'npm_update_preflight_failed',
    'npm_update_preflight_invalid',
    'npm_update_preflight_not_ready',
    'npm_update_preflight_version_mismatch'
  ].includes(message)
}
