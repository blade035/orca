import { execFile } from 'node:child_process'
import { isIPv4 } from 'node:net'

const TAILSCALE_ADDRESS_TIMEOUT_MS = 1_500

export async function discoverServerPairingAddress(
  explicitAddress?: string,
  readTailscaleAddress: () => Promise<string | null> = readTailscaleIpv4
): Promise<{ address: string; source: 'explicit' | 'tailscale' | 'loopback' }> {
  if (explicitAddress) {
    return { address: explicitAddress, source: 'explicit' }
  }
  const tailscaleAddress = await readTailscaleAddress()
  return tailscaleAddress && isIPv4(tailscaleAddress)
    ? { address: tailscaleAddress, source: 'tailscale' }
    : { address: '127.0.0.1', source: 'loopback' }
}

function readTailscaleIpv4(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'tailscale',
      ['ip', '-4'],
      { timeout: TAILSCALE_ADDRESS_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        const address = stdout.trim().split(/\s+/)[0]
        resolve(address ?? null)
      }
    )
  })
}
