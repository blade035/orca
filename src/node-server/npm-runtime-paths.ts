import { join } from 'node:path'

export const NPM_RUNTIME_STATE_SCHEMA_VERSION = 1 as const

export function getNpmRuntimeRoot(dataPath: string): string {
  return join(dataPath, 'npm-runtime')
}

export function getNpmRuntimeStatePath(dataPath: string): string {
  return join(getNpmRuntimeRoot(dataPath), 'supervisor-state.json')
}

export function getNpmSupervisorLockRoot(dataPath: string): string {
  return join(getNpmRuntimeRoot(dataPath), 'supervisor-owner')
}

export function getNpmRuntimeVersionDirectory(dataPath: string, version: string): string {
  return join(getNpmRuntimeRoot(dataPath), 'versions', version)
}

export function getNpmRuntimeEntryPath(dataPath: string, version: string): string {
  return join(
    getNpmRuntimeVersionDirectory(dataPath, version),
    'node_modules',
    '@stablyai',
    'orca',
    'dist',
    'cli.js'
  )
}

export function getNpmRuntimeSentinelPath(dataPath: string, version: string): string {
  return join(getNpmRuntimeVersionDirectory(dataPath, version), '.install-complete')
}
