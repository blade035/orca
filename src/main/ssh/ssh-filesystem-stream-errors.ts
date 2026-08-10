import { JsonRpcErrorCode, RelayErrorCode } from './relay-protocol'

export function isMethodNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  return (error as { code?: unknown }).code === JsonRpcErrorCode.MethodNotFound
}

export class StreamProtocolError extends Error {
  readonly code = RelayErrorCode.StreamProtocolError
}
