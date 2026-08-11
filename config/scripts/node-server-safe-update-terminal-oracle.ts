import type { PairingOffer } from '../../src/shared/pairing'
import { sendRemoteRuntimeRequest } from '../../src/shared/remote-runtime-client'
import type { RuntimeTerminalRead } from '../../src/shared/runtime-types'
import type { TerminalIdentity } from './node-server-update-package-fixture'

export async function reattachTerminal(
  pairing: PairingOffer,
  expected: TerminalIdentity
): Promise<TerminalIdentity> {
  const listed = await call<{ terminals: { handle: string; ptyId?: string }[] }>(
    pairing,
    'terminal.list',
    { worktree: expected.workspaceSelector }
  )
  const terminal = listed.terminals.find((candidate) => candidate.ptyId === expected.ptyId)
  assert(terminal, 'replacement did not adopt the original PTY identity')
  return { ...expected, handle: terminal.handle }
}

export async function sendAndObserveMarker(
  pairing: PairingOffer,
  handle: string,
  marker: string
): Promise<void> {
  const result = await call<{
    send: { accepted: boolean; bytesWritten: number }
  }>(pairing, 'terminal.send', { terminal: handle, text: marker, enter: true })
  assert(result.send.accepted, 'post-update terminal input was refused')
  assert(result.send.bytesWritten > 0, 'post-update terminal input wrote no bytes')

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const read = await call<{ terminal: RuntimeTerminalRead }>(pairing, 'terminal.read', {
      terminal: handle,
      limit: 200
    })
    if (read.terminal.tail.join('\n').includes(marker)) {
      return
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error('post-update terminal output marker was not observed')
}

async function call<TResult>(
  pairing: PairingOffer,
  method: string,
  params?: unknown
): Promise<TResult> {
  const response = await sendRemoteRuntimeRequest<TResult>(pairing, method, params, 15_000)
  if (!response.ok) {
    throw new Error(`${method} failed: ${response.error.message}`)
  }
  return response.result
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}
