import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isExactNpmVersion } from './npm-supervisor-protocol'

export function readNpmRuntimeVersion(runtimeDirectory = __dirname): string {
  const installedManifestPath = join(runtimeDirectory, '..', 'package.json')
  const manifestPath = existsSync(installedManifestPath)
    ? installedManifestPath
    : join(runtimeDirectory, '..', '..', 'package.json')
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
  } catch {
    throw new Error('npm_runtime_package_manifest_invalid')
  }
  if (!isPackageManifest(manifest) || !isExactNpmVersion(manifest.version)) {
    throw new Error('npm_runtime_package_version_invalid')
  }
  return manifest.version
}

function isPackageManifest(value: unknown): value is { version: string } {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'version') === 'string'
  )
}
