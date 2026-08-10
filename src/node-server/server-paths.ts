import { chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function resolveServerDataPath(explicitPath?: string): string {
  if (explicitPath) {
    return resolve(explicitPath)
  }
  if (process.env.ORCA_SERVER_DATA_DIR) {
    return resolve(process.env.ORCA_SERVER_DATA_DIR)
  }
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? homedir(), 'Orca Server')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Orca Server')
  }
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'orca')
}

export function ensureServerDataPath(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    chmodSync(path, 0o700)
  }
}
