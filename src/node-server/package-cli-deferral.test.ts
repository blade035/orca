import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  configureProfile: vi.fn(),
  controlMain: vi.fn(),
  serverEntryLoaded: false
}))

vi.mock('../cli/cli-program', () => ({ main: state.controlMain }))
vi.mock('./server-profile-environment', () => ({
  configureServerControlProfileEnvironment: state.configureProfile
}))
vi.mock('./index', () => {
  state.serverEntryLoaded = true
  return { reportNodeServerFailure: vi.fn(), runNodeServer: vi.fn() }
})

describe('package CLI module deferral', () => {
  beforeEach(() => {
    state.controlMain.mockReset()
    state.configureProfile.mockReset()
    state.serverEntryLoaded = false
  })

  it('does not evaluate the server entry for control CLI help', async () => {
    const originalArgv = process.argv
    process.argv = [process.execPath, 'cli.js', '--help']
    try {
      await import('./package-cli')
      await vi.waitFor(() => expect(state.controlMain).toHaveBeenCalledWith(['--help']))
      expect(state.configureProfile).toHaveBeenCalledOnce()
      expect(state.serverEntryLoaded).toBe(false)
    } finally {
      process.argv = originalArgv
    }
  })
})
