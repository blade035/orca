import { createHeadlessAutomationOutputSnapshotBuffer } from '../main/automations/headless-dispatch'
import type { HeadlessAutomationDispatcher } from '../main/automations/headless-dispatch'
import { buildHeadlessAutomationWorktreeCreateArgs } from '../main/automations/headless-workspace-create'
import type { OrcaRuntimeService } from '../main/runtime/orca-runtime'

const TERMINAL_SNAPSHOT_LIMIT = 2_000
const RUNTIME_OPERATION_SHUTDOWN_GRACE_MS = 1_000
const SHUTDOWN_ERROR = 'Automation stopped during server shutdown.'

type RuntimeOperationSettlement<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }

export function createBrowserlessAutomationDispatcher(
  runtime: OrcaRuntimeService
): HeadlessAutomationDispatcher {
  return async ({ automation, run, target, signal }) => {
    if (signal?.aborted) {
      throw new Error(SHUTDOWN_ERROR)
    }
    let terminalHandle: string
    let terminalSessionId: string | null = null
    let terminalPaneKey: string | null = null
    let terminalPtyId: string | null = null
    let workspaceId: string
    let workspaceDisplayName: string | null = null

    if (automation.workspaceMode === 'new_per_run') {
      const created = await awaitRuntimeOperation(
        () =>
          runtime.createManagedWorktree({
            ...buildHeadlessAutomationWorktreeCreateArgs({ automation, run, repo: target.repo }),
            signal
          }),
        signal,
        'join'
      )
      terminalHandle = created.startupTerminal?.handle ?? ''
      terminalSessionId = created.startupTerminal?.tabId ?? null
      terminalPaneKey = created.startupTerminal?.paneKey ?? null
      terminalPtyId = created.startupTerminal?.ptyId ?? null
      workspaceId = created.worktree.id
      workspaceDisplayName = created.worktree.displayName ?? null
      if (!terminalHandle) {
        throw new Error(
          created.warning || 'Automation workspace was created, but no agent terminal started.'
        )
      }
    } else {
      if (!automation.workspaceId) {
        throw new Error('The target workspace is no longer available.')
      }
      const terminal = await awaitRuntimeOperation(
        () =>
          runtime.launchAgentTerminal(`id:${automation.workspaceId}`, {
            agent: automation.agentId,
            prompt: automation.prompt,
            title: run.title,
            signal
          }),
        signal
      )
      terminalHandle = terminal.handle
      terminalSessionId = terminal.tabId ?? null
      terminalPaneKey = terminal.paneKey ?? null
      terminalPtyId = terminal.ptyId ?? null
      workspaceId = terminal.worktreeId
      const worktree = await awaitRuntimeOperation(
        () => runtime.showManagedWorktree(`id:${workspaceId}`),
        signal
      )
      workspaceDisplayName = worktree.displayName ?? null
    }

    return {
      workspaceId,
      workspaceDisplayName,
      terminalSessionId,
      terminalPaneKey,
      terminalPtyId,
      completion: captureCompletion(runtime, terminalHandle, signal)
    }
  }
}

async function captureCompletion(
  runtime: OrcaRuntimeService,
  terminalHandle: string,
  signal?: AbortSignal
): Promise<{
  status: 'completed' | 'dispatch_failed'
  outputSnapshot: ReturnType<
    ReturnType<typeof createHeadlessAutomationOutputSnapshotBuffer>['snapshot']
  >
  error: string | null
}> {
  try {
    const wait = await awaitRuntimeOperation(
      () => runtime.waitForTerminal(terminalHandle, { condition: 'tui-idle', signal }),
      signal
    )
    if (signal?.aborted) {
      return shutdownCompletion()
    }
    const read = await awaitRuntimeOperation(
      () => runtime.readTerminal(terminalHandle, { limit: TERMINAL_SNAPSHOT_LIMIT }),
      signal
    )
    const snapshotBuffer = createHeadlessAutomationOutputSnapshotBuffer()
    snapshotBuffer.append(read.tail.join('\n'))
    if (wait.satisfied) {
      return {
        status: 'completed',
        outputSnapshot: snapshotBuffer.snapshot(),
        error: null
      }
    }
    return {
      status: 'dispatch_failed',
      outputSnapshot: snapshotBuffer.snapshot(),
      error: wait.blockedReason
        ? `Automation agent is blocked: ${wait.blockedReason}.`
        : 'Automation agent did not report completion.'
    }
  } catch (error) {
    if (signal?.aborted) {
      return shutdownCompletion()
    }
    throw error
  }
}

function shutdownCompletion(): {
  status: 'dispatch_failed'
  outputSnapshot: null
  error: string
} {
  return {
    status: 'dispatch_failed',
    outputSnapshot: null,
    error: SHUTDOWN_ERROR
  }
}

async function awaitRuntimeOperation<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
  shutdownSettlement: 'grace' | 'join' = 'grace'
): Promise<T> {
  if (signal?.aborted) {
    throw new Error(SHUTDOWN_ERROR)
  }
  const settlement = operation().then<RuntimeOperationSettlement<T>, RuntimeOperationSettlement<T>>(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason })
  )
  if (!signal) {
    return unwrapRuntimeOperationSettlement(await settlement)
  }
  let onAbort!: () => void
  const aborted = new Promise<{ status: 'aborted' }>((resolve) => {
    onAbort = () => resolve({ status: 'aborted' })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
    }
  })
  const first = await Promise.race([settlement, aborted])
  signal.removeEventListener('abort', onAbort)
  if (first.status !== 'aborted') {
    if (signal.aborted) {
      throw new Error(SHUTDOWN_ERROR)
    }
    return unwrapRuntimeOperationSettlement(first)
  }

  // Why: read-only runtime operations may lack cancellation; observe their
  // outcome without letting them block shutdown indefinitely.
  await (shutdownSettlement === 'join'
    ? settlement
    : waitForRuntimeOperationShutdownGrace(settlement))
  throw new Error(SHUTDOWN_ERROR)
}

function waitForRuntimeOperationShutdownGrace<T>(
  settlement: Promise<RuntimeOperationSettlement<T>>
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, RUNTIME_OPERATION_SHUTDOWN_GRACE_MS)
    void settlement.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function unwrapRuntimeOperationSettlement<T>(settlement: RuntimeOperationSettlement<T>): T {
  if (settlement.status === 'rejected') {
    throw settlement.reason
  }
  return settlement.value
}
