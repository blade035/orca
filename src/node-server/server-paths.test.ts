import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureServerDataPath, resolveLinuxStateHome, resolveServerDataPath } from './server-paths'

const originalDataDirectory = process.env.ORCA_SERVER_DATA_DIR
const createdPaths: string[] = []

afterEach(() => {
  if (originalDataDirectory === undefined) {
    delete process.env.ORCA_SERVER_DATA_DIR
  } else {
    process.env.ORCA_SERVER_DATA_DIR = originalDataDirectory
  }
  for (const path of createdPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true })
  }
})

describe('server data paths', () => {
  it('prefers an explicit path over the environment', () => {
    process.env.ORCA_SERVER_DATA_DIR = './environment-state'
    expect(resolveServerDataPath('./explicit-state')).toBe(resolve('./explicit-state'))
  })

  it('uses the server environment path when no flag is supplied', () => {
    process.env.ORCA_SERVER_DATA_DIR = './environment-state'
    expect(resolveServerDataPath()).toBe(resolve('./environment-state'))
  })

  it('ignores a relative XDG state directory', () => {
    expect(resolveLinuxStateHome('relative-state', '/home/ada')).toBe('/home/ada/.local/state')
    expect(resolveLinuxStateHome('/var/lib/ada', '/home/ada')).toBe('/var/lib/ada')
  })

  it('creates an owner-only state directory on POSIX', () => {
    const parent = mkdtempSync(join(tmpdir(), 'orca-server-paths-'))
    const dataPath = join(parent, 'state')
    createdPaths.push(parent)
    ensureServerDataPath(dataPath)
    expect(statSync(dataPath).isDirectory()).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(dataPath).mode & 0o777).toBe(0o700)
    }
  })
})
