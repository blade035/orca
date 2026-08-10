import { describe, expect, it } from 'vitest'
import { requireServerWebSocketEndpoint } from './server-websocket-readiness'

describe('requireServerWebSocketEndpoint', () => {
  it('rejects readiness without a remote listener', () => {
    expect(() => requireServerWebSocketEndpoint(null)).toThrow('WebSocket listener failed')
    expect(requireServerWebSocketEndpoint('ws://127.0.0.1:6768')).toBe('ws://127.0.0.1:6768')
  })
})
