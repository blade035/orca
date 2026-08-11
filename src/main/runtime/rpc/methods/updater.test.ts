import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureRemoteServerUpdater } from '../../remote-server-updater'
import { STATUS_METHODS } from './status'
import { UPDATER_METHODS } from './updater'

const snapshot = {
  appVersion: '1.5.0',
  runtimeId: 'runtime-rpc',
  support: { installMode: 'interactive', automatic: true, reason: 'available' },
  status: { state: 'available', version: '1.5.1', changelog: null }
} as const

function handler(methods: typeof UPDATER_METHODS, name: string) {
  const method = methods.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`Missing method ${name}`)
  }
  return method.handler
}

describe('runtime updater RPC methods', () => {
  const getSnapshot = vi.fn(() => snapshot)
  const check = vi.fn(() => snapshot)
  const download = vi.fn(() => snapshot)
  const install = vi.fn(() => ({
    accepted: true as const,
    fromVersion: '1.5.0',
    targetVersion: '1.5.1',
    runtimeId: 'runtime-rpc'
  }))
  const runtime = {
    getRuntimeId: () => 'runtime-rpc',
    getStatus: () => ({ runtimeId: 'runtime-rpc', liveTabCount: 2, liveLeafCount: 3 })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    configureRemoteServerUpdater({ getSnapshot, check, download, install })
  })

  it('exposes status and each update transition', async () => {
    const context = {
      runtime,
      clientCapabilities: ['updater.safe-install-ack.v1'],
      pairedDeviceId: 'device-a'
    } as never
    expect(await handler(UPDATER_METHODS, 'updater.getStatus')(undefined, context)).toBe(snapshot)
    expect(
      await handler(UPDATER_METHODS, 'updater.check')(
        {
          includePrerelease: false,
          includePerfPrerelease: true,
          targetVersion: '1.5.1'
        },
        context
      )
    ).toBe(snapshot)
    expect(await handler(UPDATER_METHODS, 'updater.download')(undefined, context)).toBe(snapshot)
    expect(await handler(UPDATER_METHODS, 'updater.install')(undefined, context)).toMatchObject({
      accepted: true,
      runtimeId: 'runtime-rpc'
    })
    expect(check).toHaveBeenCalledWith('runtime-rpc', {
      includePrerelease: false,
      includePerfPrerelease: true,
      targetVersion: '1.5.1'
    })
    expect(getSnapshot).toHaveBeenCalledWith('runtime-rpc', {
      clientCapabilities: ['updater.safe-install-ack.v1'],
      requesterId: 'device-a'
    })
    expect(install).toHaveBeenCalledWith('runtime-rpc', ['updater.safe-install-ack.v1'], 'device-a')
  })

  it('enriches status.get without changing the runtime status source', async () => {
    const result = await handler(STATUS_METHODS, 'status.get')(undefined, {
      runtime,
      clientCapabilities: ['updater.safe-install-ack.v1']
    } as never)
    expect(result).toEqual({
      runtimeId: 'runtime-rpc',
      liveTabCount: 2,
      liveLeafCount: 3,
      appVersion: '1.5.0',
      remoteUpdateSupport: snapshot.support
    })
    expect(getSnapshot).toHaveBeenCalledWith('runtime-rpc', {
      clientCapabilities: ['updater.safe-install-ack.v1']
    })
  })
})
