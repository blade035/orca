import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { Store } from '../persistence'

export async function evaluateScheduledAutomation(args: {
  store: Store
  automation: Automation
  now: number
  requestDispatch: (automation: Automation, run: AutomationRun) => Promise<AutomationRun>
}): Promise<void> {
  const { store, automation, now, requestDispatch } = args
  const scheduledFor = store.getLatestAutomationOccurrence(automation, now)
  if (scheduledFor === null) {
    store.advanceAutomationNextRun(automation.id, now)
    return
  }
  const run = store.createAutomationRun(automation, scheduledFor)
  try {
    const graceMs = automation.missedRunGraceMinutes * 60 * 1000
    if (now - scheduledFor > graceMs) {
      store.updateAutomationRun({
        runId: run.id,
        status: 'skipped_missed',
        workspaceId: automation.workspaceId,
        error: 'Orca was unavailable during the missed-run grace window.'
      })
      return
    }

    await requestDispatch(automation, run)
  } catch (error) {
    try {
      store.updateAutomationRun({
        runId: run.id,
        status: 'dispatch_failed',
        workspaceId: automation.workspaceId,
        error: error instanceof Error ? error.message : String(error)
      })
    } catch (persistenceError) {
      throw new AggregateError(
        [error, persistenceError],
        `Automation ${automation.id} dispatch and failure persistence both failed`
      )
    }
  } finally {
    store.advanceAutomationNextRun(automation.id, now)
  }
}
