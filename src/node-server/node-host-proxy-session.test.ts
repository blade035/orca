import { beforeEach, describe, expect, it, vi } from 'vitest'

const setGlobalProxyFromEnv = vi.hoisted(() => vi.fn())

vi.mock('node:http', () => ({ setGlobalProxyFromEnv }))

import { session } from './node-host-electron-facade'

describe('Node host proxy session', () => {
  beforeEach(() => {
    setGlobalProxyFromEnv.mockReset()
  })

  it('reports direct routing so environment proxy settings can be applied', async () => {
    await expect(session.defaultSession.resolveProxy()).resolves.toBe('DIRECT')
  })

  it('applies fixed proxy settings to Node fetch and HTTP clients', async () => {
    await session.defaultSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: 'http://proxy.example:8080',
      proxyBypassRules: 'localhost;*.internal'
    })

    expect(setGlobalProxyFromEnv).toHaveBeenCalledWith({
      HTTP_PROXY: 'http://proxy.example:8080',
      HTTPS_PROXY: 'http://proxy.example:8080',
      NO_PROXY: 'localhost,*.internal'
    })
  })
})
