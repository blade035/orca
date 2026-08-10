import { randomUUID } from 'node:crypto'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

const SETUP_MUTATION_TIMEOUT_MS = 8_000

export class SshFilesystemMutationSettlementError extends Error {
  constructor(method: string, cause: unknown) {
    super(`Remote ${method} settlement could not be confirmed; automatic rollback was skipped.`, {
      cause
    })
  }
}

export async function requestSettledSshFilesystemMutation(
  mux: SshChannelMultiplexer,
  method: 'fs.createDir' | 'fs.writeFile',
  params: Record<string, unknown>
): Promise<void> {
  const operationId = randomUUID()
  try {
    const result = (await mux.request(
      method,
      { ...params, operationId },
      { timeoutMs: SETUP_MUTATION_TIMEOUT_MS }
    )) as { mutationTracked?: boolean } | undefined
    if (result?.mutationTracked) {
      mux.notify('fs.releaseMutation', { operationId })
    }
  } catch (mutationError) {
    try {
      const settlement = (await mux.request(
        'fs.awaitMutation',
        { operationId },
        { timeoutMs: SETUP_MUTATION_TIMEOUT_MS }
      )) as { found?: boolean }
      if (settlement.found !== true) {
        throw new Error('Remote mutation operation was not found.')
      }
    } catch (settlementError) {
      throw new SshFilesystemMutationSettlementError(method, [mutationError, settlementError])
    } finally {
      mux.notify('fs.releaseMutation', { operationId })
    }
    throw mutationError
  }
}
