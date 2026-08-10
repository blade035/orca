import { describe, expect, it } from 'vitest'
import { resolveServerBindHost } from './server-bind-host'

describe('server bind host', () => {
  it('binds explicit IPv6 advertisements on an IPv6 listener', () => {
    expect(resolveServerBindHost(undefined, { address: '::1', source: 'explicit' })).toBe('::')
    expect(
      resolveServerBindHost(undefined, {
        address: 'ws://[2001:db8::4]:6768',
        source: 'explicit'
      })
    ).toBe('::')
  })

  it('preserves explicit listeners and existing IPv4 defaults', () => {
    expect(resolveServerBindHost('127.0.0.2', { address: '::1', source: 'explicit' })).toBe(
      '127.0.0.2'
    )
    expect(resolveServerBindHost(undefined, { address: 'host.example', source: 'explicit' })).toBe(
      '0.0.0.0'
    )
    expect(resolveServerBindHost(undefined, { address: '100.64.1.2', source: 'tailscale' })).toBe(
      '100.64.1.2'
    )
    expect(resolveServerBindHost(undefined, { address: '127.0.0.1', source: 'loopback' })).toBe(
      '127.0.0.1'
    )
  })
})
