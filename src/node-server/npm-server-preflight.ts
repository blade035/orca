import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readNpmRuntimeVersion } from './npm-runtime-version'
import { NPM_SUPERVISOR_PROTOCOL_VERSION, isExactNpmVersion } from './npm-supervisor-protocol'
import { PROTOCOL_VERSION as DAEMON_PROTOCOL_VERSION } from '../main/daemon/daemon-protocol-version'

export function runNpmServerPreflight(argv: string[]): void {
  const expectedVersion = readExpectedVersion(argv)
  const runtimeVersion = readNpmRuntimeVersion()
  const packageRoot = join(__dirname, '..')
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    name?: unknown
  }
  const requiredFiles = [
    join(__dirname, 'cli.js'),
    join(__dirname, 'daemon-entry.js'),
    join(__dirname, 'web', 'web-index.html')
  ]
  if (runtimeVersion !== expectedVersion) {
    throw new Error('npm_preflight_version_mismatch')
  }
  if (manifest.name !== '@stablyai/orca') {
    throw new Error('npm_preflight_package_identity_mismatch')
  }
  if (requiredFiles.some((path) => !existsSync(path))) {
    throw new Error('npm_preflight_package_incomplete')
  }
  const requireFromPackage = createRequire(join(packageRoot, 'package.json'))
  for (const dependency of ['@parcel/watcher', 'node-pty', 'ssh2', 'tweetnacl', 'ws']) {
    requireFromPackage.resolve(dependency)
  }
  for (const nativeDependency of ['@parcel/watcher', 'node-pty']) {
    requireFromPackage(nativeDependency)
  }
  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      version: runtimeVersion,
      daemonProtocolVersion: DAEMON_PROTOCOL_VERSION,
      supervisorProtocolVersion: NPM_SUPERVISOR_PROTOCOL_VERSION
    })}\n`
  )
}

function readExpectedVersion(argv: string[]): string {
  const flagIndex = argv.indexOf('--expected-version')
  const value = flagIndex !== -1 ? argv[flagIndex + 1] : undefined
  if (!value || !isExactNpmVersion(value)) {
    throw new Error('npm_preflight_expected_version_required')
  }
  return value
}
