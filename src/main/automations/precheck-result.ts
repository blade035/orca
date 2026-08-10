import type { AutomationPrecheck, AutomationPrecheckResult } from '../../shared/automations-types'
import { MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS } from '../../shared/automation-precheck'

export type PrecheckTailBuffer = {
  content: string
  truncated: boolean
}

export const PRECHECK_CANCELLED_ERROR = 'Precheck cancelled.'

export function appendPrecheckTail(buffer: PrecheckTailBuffer, chunk: string): PrecheckTailBuffer {
  const content = `${buffer.content}${chunk}`
  if (content.length <= MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS) {
    return { ...buffer, content }
  }
  return {
    content: content.slice(-MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS),
    truncated: true
  }
}

export function createPrecheckResult(args: {
  precheck: AutomationPrecheck
  startedAt: number
  stdout: PrecheckTailBuffer
  stderr: PrecheckTailBuffer
  exitCode: number | null
  timedOut: boolean
  error: string | null
}): AutomationPrecheckResult {
  const completedAt = Date.now()
  return {
    command: args.precheck.command,
    exitCode: args.exitCode,
    timedOut: args.timedOut,
    durationMs: Math.max(0, completedAt - args.startedAt),
    stdout: args.stdout.content,
    stderr: args.stderr.content,
    stdoutTruncated: args.stdout.truncated,
    stderrTruncated: args.stderr.truncated,
    error: args.error,
    startedAt: args.startedAt,
    completedAt
  }
}

export function failedPrecheckResult(
  precheck: AutomationPrecheck,
  startedAt: number,
  error: string
): AutomationPrecheckResult {
  return createPrecheckResult({
    precheck,
    startedAt,
    stdout: { content: '', truncated: false },
    stderr: { content: '', truncated: false },
    exitCode: null,
    timedOut: false,
    error
  })
}
