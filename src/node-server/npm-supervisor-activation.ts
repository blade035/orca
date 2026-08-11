import { compareAppVersions } from '../shared/app-version'
import type { NpmUpdateActivationMessage, NpmWorkerReadyMessage } from './npm-supervisor-protocol'
import type { reportNpmActivationFailure } from './npm-supervised-worker'

export function npmActivationRejectionReason(
  activation: NpmUpdateActivationMessage,
  ready: NpmWorkerReadyMessage
): string | null {
  if (activation.runtimeId !== ready.runtimeId) {
    return 'npm_update_stale_runtime'
  }
  if (activation.fromVersion !== ready.version) {
    return 'npm_update_source_version_mismatch'
  }
  if (compareAppVersions(activation.targetVersion, activation.fromVersion) <= 0) {
    return 'npm_update_target_not_newer'
  }
  return null
}

export function npmActivationFailure(
  activation: NpmUpdateActivationMessage,
  reason: string
): Parameters<typeof reportNpmActivationFailure>[1] {
  return {
    requestId: activation.requestId,
    fromVersion: activation.fromVersion,
    targetVersion: activation.targetVersion,
    originRuntimeId: activation.runtimeId,
    reason
  }
}

export function safeNpmSupervisorError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return /^[a-z0-9_:-]+$/i.test(message) ? message : 'npm_update_candidate_start_failed'
}
