import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError, readFileViaStream } from '../ssh/ssh-filesystem-stream-reader'
import type { FileReadResult } from './types'
import { requestSshFilesystemWithSignal } from './ssh-filesystem-cancellable-request'

export async function readSshFilesystemFile(
  mux: SshChannelMultiplexer,
  filePath: string,
  signal: AbortSignal | undefined,
  onLegacyFallback: () => void
): Promise<FileReadResult> {
  try {
    return await readFileViaStream(mux, filePath, signal)
  } catch (error) {
    if (!isMethodNotFoundError(error)) {
      throw error
    }
    onLegacyFallback()
    return requestSshFilesystemWithSignal(mux, 'fs.readFile', { filePath }, signal)
  }
}
