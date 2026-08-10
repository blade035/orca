import { isIPv6 } from 'node:net'
import { resolveAdvertisedPairingHostname } from '../main/runtime/pairing-endpoint'

type PairingAddress = {
  address: string
  source: 'explicit' | 'tailscale' | 'loopback'
}

export function resolveServerBindHost(
  listenHost: string | undefined,
  pairingAddress: PairingAddress
): string {
  if (listenHost) {
    return listenHost
  }
  if (pairingAddress.source === 'tailscale') {
    return pairingAddress.address
  }
  if (pairingAddress.source === 'loopback') {
    return '127.0.0.1'
  }
  const advertisedHostname = resolveAdvertisedPairingHostname(pairingAddress.address)
  return advertisedHostname && isIPv6(advertisedHostname) ? '::' : '0.0.0.0'
}
