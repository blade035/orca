import type {
  AutomationDispatchResult,
  AutomationPrecheckResult,
  AutomationRun
} from '../../shared/automations-types'
import type { HeadlessAutomationDispatchLaunch } from './headless-dispatch'

export function buildHeadlessAutomationRunTarget(launch: HeadlessAutomationDispatchLaunch): {
  workspaceId: string
  workspaceDisplayName: string | null
  terminalSessionId: string | null
  terminalPaneKey: string | null
  terminalPtyId: string | null
} {
  return {
    workspaceId: launch.workspaceId,
    workspaceDisplayName: launch.workspaceDisplayName ?? null,
    terminalSessionId: launch.terminalSessionId,
    terminalPaneKey: launch.terminalPaneKey ?? null,
    terminalPtyId: launch.terminalPtyId ?? null
  }
}

export function settleHeadlessAutomationCompletion(args: {
  completion: NonNullable<HeadlessAutomationDispatchLaunch['completion']>
  runId: string
  target: ReturnType<typeof buildHeadlessAutomationRunTarget>
  precheckResult: AutomationPrecheckResult | null
  mark: (result: AutomationDispatchResult) => Promise<AutomationRun>
}): Promise<AutomationRun> {
  return args.completion
    .then((completion) =>
      args.mark({
        runId: args.runId,
        status: completion.status,
        ...args.target,
        precheckResult: args.precheckResult,
        outputSnapshot: completion.outputSnapshot ?? null,
        error: completion.error ?? null
      })
    )
    .catch((error) =>
      args.mark({
        runId: args.runId,
        status: 'dispatch_failed',
        ...args.target,
        error: error instanceof Error ? error.message : String(error)
      })
    )
}
