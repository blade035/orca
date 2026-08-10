import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveOrcaManagedCodexHomePath } from '../main/codex/codex-home-paths'
import {
  configureServerControlProfileEnvironment,
  configureServerProfileEnvironment
} from './server-profile-environment'

const originalEnvironment = {
  serverDataPath: process.env.ORCA_SERVER_DATA_DIR,
  userDataPath: process.env.ORCA_USER_DATA_PATH
}

afterEach(() => {
  if (originalEnvironment.userDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = originalEnvironment.userDataPath
  }
  if (originalEnvironment.serverDataPath === undefined) {
    delete process.env.ORCA_SERVER_DATA_DIR
  } else {
    process.env.ORCA_SERVER_DATA_DIR = originalEnvironment.serverDataPath
  }
})

describe('server profile environment', () => {
  it('roots managed Codex state in the selected server profile', () => {
    const dataPath = join('custom', 'server-profile')

    configureServerProfileEnvironment(dataPath)

    expect(resolveOrcaManagedCodexHomePath()).toBe(join(dataPath, 'codex-runtime-home', 'home'))
  })

  it('gives an explicit server profile precedence over an inherited desktop profile', () => {
    process.env.ORCA_USER_DATA_PATH = join('desktop', 'profile')
    process.env.ORCA_SERVER_DATA_DIR = join('server', 'profile')

    configureServerControlProfileEnvironment()

    expect(process.env.ORCA_USER_DATA_PATH).toBe(join(process.cwd(), 'server', 'profile'))
  })

  it('preserves an inherited profile when no server override is explicit', () => {
    const inherited = join('desktop', 'profile')
    process.env.ORCA_USER_DATA_PATH = inherited
    delete process.env.ORCA_SERVER_DATA_DIR

    configureServerControlProfileEnvironment()

    expect(process.env.ORCA_USER_DATA_PATH).toBe(inherited)
  })
})
