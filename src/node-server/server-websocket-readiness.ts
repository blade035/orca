export function requireServerWebSocketEndpoint(endpoint: string | null): string {
  if (!endpoint) {
    throw new Error('The remote WebSocket listener failed to start; no readiness was published.')
  }
  return endpoint
}
