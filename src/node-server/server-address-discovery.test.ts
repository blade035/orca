import { describe, expect, it, vi } from 'vitest'
import { discoverServerPairingAddress } from './server-address-discovery'

describe('discoverServerPairingAddress', () => {
  it('uses the explicit address without probing Tailscale', async () => {
    const probe = vi.fn<() => Promise<string | null>>()
    await expect(discoverServerPairingAddress('host.example.test', probe)).resolves.toEqual({
      address: 'host.example.test',
      source: 'explicit'
    })
    expect(probe).not.toHaveBeenCalled()
  })

  it('advertises a detected Tailscale address', async () => {
    await expect(
      discoverServerPairingAddress(undefined, async () => '100.64.1.20')
    ).resolves.toEqual({ address: '100.64.1.20', source: 'tailscale' })
  })

  it('stays on loopback when Tailscale is unavailable', async () => {
    await expect(discoverServerPairingAddress(undefined, async () => null)).resolves.toEqual({
      address: '127.0.0.1',
      source: 'loopback'
    })
  })

  it.each(['999.999.999.999', '256.0.0.1', '01.2.3.4'])(
    'stays on loopback for invalid Tailscale IPv4 output %s',
    async (address) => {
      await expect(discoverServerPairingAddress(undefined, async () => address)).resolves.toEqual({
        address: '127.0.0.1',
        source: 'loopback'
      })
    }
  )
})
