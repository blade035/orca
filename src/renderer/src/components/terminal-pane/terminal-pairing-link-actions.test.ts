import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../../../shared/pairing'
import { openTerminalPairingLink } from './terminal-pairing-link-actions'

const mocks = vi.hoisted(() => ({
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks
  }
}))

describe('openTerminalPairingLink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens the remote server form with the access link prefilled', () => {
    const accessLink = encodePairingOffer({
      v: 2,
      endpoint: 'ws://192.168.1.10:6768',
      deviceToken: 'device-token',
      publicKeyB64: 'public-key'
    })

    expect(openTerminalPairingLink(accessLink)).toBe(true)
    expect(mocks.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'servers',
      repoId: null,
      intent: 'add-remote-orca-server',
      accessLink
    })
    expect(mocks.openSettingsPage).toHaveBeenCalledOnce()
  })

  it('does not route malformed or mobile-only pairing links', () => {
    const mobileLink = encodePairingOffer({
      v: 2,
      endpoint: 'ws://192.168.1.10:6768',
      deviceToken: 'device-token',
      publicKeyB64: 'public-key',
      scope: 'mobile'
    })

    expect(openTerminalPairingLink('orca://unknown?code=secret')).toBe(false)
    expect(openTerminalPairingLink(mobileLink)).toBe(false)
    expect(mocks.openSettingsTarget).not.toHaveBeenCalled()
    expect(mocks.openSettingsPage).not.toHaveBeenCalled()
  })
})
