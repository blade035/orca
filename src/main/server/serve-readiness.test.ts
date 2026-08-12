import { describe, expect, it, vi } from 'vitest'
import {
  renderServeReadiness,
  ServeReadinessPublisher,
  type ServeReadiness
} from './serve-readiness'

const ready: ServeReadiness = {
  runtimeId: 'runtime-1',
  boundEndpoint: 'ws://0.0.0.0:6768',
  advertisedEndpoint: 'wss://orca.example.test/runtime',
  managedWslCliReconciliation: 'settled',
  pairing: {
    available: true,
    url: 'orca://pair?code=secret',
    endpoint: 'wss://orca.example.test/runtime',
    deviceId: 'device-1',
    webClientUrl: 'https://orca.example.test/runtime/web-index.html#pairing=secret',
    scope: 'runtime',
    qr: null
  }
}

describe('ServeReadinessPublisher', () => {
  it('does not publish readiness after startup cancellation', async () => {
    const write = vi.fn(async () => {})
    const publisher = new ServeReadinessPublisher(write)

    await expect(
      publisher.publish(ready, { mode: 'human' }, AbortSignal.abort())
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(write).not.toHaveBeenCalled()
  })

  it('writes one complete human-readable ready block', async () => {
    const write = vi.fn(async () => {})
    const publisher = new ServeReadinessPublisher(write)

    await publisher.publish(ready, { mode: 'human' })

    expect(write).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining(
        'Orca server is ready\n\nOpen the web client:\nWeb client URL: https://orca.example.test/runtime/web-index.html#pairing=secret'
      )
    )
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('Pairing URL: orca://pair?code=secret\n')
    )
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining(
        'Server details:\nBound endpoint: ws://0.0.0.0:6768\nAdvertised endpoint: wss://orca.example.test/runtime'
      )
    )
  })

  it('uses compact clickable actions in supported interactive terminals', async () => {
    const write = vi.fn(async (_output: string) => {})
    const publisher = new ServeReadinessPublisher(write, { hyperlinks: true })

    await publisher.publish(ready, { mode: 'human' })

    const output = write.mock.calls[0]?.[0] ?? ''
    expect(output).toContain('Orca server is ready\n\nConnect')
    expect(output).toContain(
      '\u001B]8;;https://orca.example.test/runtime/web-index.html#pairing=secret\u001B\\Open web client\u001B]8;;\u001B\\'
    )
    expect(output).toContain(
      '\u001B]8;;orca://pair?code=secret\u001B\\Add this host\u001B]8;;\u001B\\'
    )
    expect(output).not.toContain('Web client URL:')
    expect(output).not.toContain('Pairing URL:')
    expect(output).toContain('These links contain access credentials. Keep them private.')
  })

  it('publishes a versioned JSON contract with explicit endpoints and pairing availability', () => {
    expect(JSON.parse(renderServeReadiness(ready, { mode: 'json' }))).toEqual({
      type: 'orca_server_ready',
      schemaVersion: 1,
      runtimeId: 'runtime-1',
      endpoint: 'ws://0.0.0.0:6768',
      boundEndpoint: 'ws://0.0.0.0:6768',
      advertisedEndpoint: 'wss://orca.example.test/runtime',
      managedWslCliReconciliation: 'settled',
      pairing: ready.pairing
    })
  })

  it('reports unavailable pairing as an explicit machine-readable object', () => {
    const unavailable: ServeReadiness = {
      ...ready,
      advertisedEndpoint: null,
      pairing: {
        available: false,
        reason: 'invalid_advertised_endpoint',
        guidance: 'Use a reachable address.'
      }
    }

    const json = JSON.parse(renderServeReadiness(unavailable, { mode: 'json' }))
    expect(json.pairing).toEqual(unavailable.pairing)
    expect(renderServeReadiness(unavailable, { mode: 'human' })).toContain(
      'Pairing unavailable: invalid_advertised_endpoint\nPairing guidance: Use a reachable address.'
    )
  })

  it('preserves the recipe JSON contract', () => {
    expect(renderServeReadiness(ready, { mode: 'recipe-json', projectRoot: '/workspace' })).toBe(
      '{"schemaVersion":1,"pairingCode":"orca://pair?code=secret","projectRoot":"/workspace"}'
    )
  })

  it('fails recipe output with the unavailable reason and guidance', () => {
    const unavailable: ServeReadiness = {
      ...ready,
      pairing: {
        available: false,
        reason: 'websocket_unavailable',
        guidance: 'Choose an unused --port.'
      }
    }
    expect(() =>
      renderServeReadiness(unavailable, { mode: 'recipe-json', projectRoot: '/workspace' })
    ).toThrow('websocket_unavailable. Choose an unused --port.')
  })

  it('rejects concurrent and later duplicate publications', async () => {
    let finishWrite: (() => void) | undefined
    const publisher = new ServeReadinessPublisher(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve
        })
    )
    const first = publisher.publish(ready, { mode: 'json' })

    await expect(publisher.publish(ready, { mode: 'json' })).rejects.toThrow(
      'publication already publishing'
    )
    finishWrite?.()
    await first
    await expect(publisher.publish(ready, { mode: 'json' })).rejects.toThrow(
      'publication already published'
    )
  })

  it('surfaces write failures and does not retry a partial contract', async () => {
    const publisher = new ServeReadinessPublisher(async () => {
      throw new Error('stdout closed')
    })

    await expect(publisher.publish(ready, { mode: 'human' })).rejects.toThrow('stdout closed')
    await expect(publisher.publish(ready, { mode: 'human' })).rejects.toThrow(
      'publication already failed'
    )
  })
})
