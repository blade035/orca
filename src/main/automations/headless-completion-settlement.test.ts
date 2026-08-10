import { describe, expect, it, vi } from 'vitest'
import type { AutomationDispatchResult, AutomationRun } from '../../shared/automations-types'
import { settleHeadlessAutomationCompletion } from './headless-completion-settlement'

describe('settleHeadlessAutomationCompletion', () => {
  it('retains the precheck result when completion fails', async () => {
    const precheckResult = {
      command: 'test -f ready',
      exitCode: 0,
      timedOut: false,
      durationMs: 5,
      stdout: 'ready',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      error: null,
      startedAt: 10,
      completedAt: 15
    }
    const mark = vi.fn(
      async (result: AutomationDispatchResult) => result as unknown as AutomationRun
    )

    await settleHeadlessAutomationCompletion({
      completion: Promise.reject(new Error('terminal read failed')),
      runId: 'run-1',
      target: {
        workspaceId: 'workspace-1',
        workspaceDisplayName: 'Workspace',
        terminalSessionId: 'session-1',
        terminalPaneKey: 'pane-1',
        terminalPtyId: 'pty-1'
      },
      precheckResult,
      mark
    })

    expect(mark).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        status: 'dispatch_failed',
        precheckResult,
        error: 'terminal read failed'
      })
    )
  })
})
