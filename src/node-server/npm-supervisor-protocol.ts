export const NPM_WORKER_COMMAND = '__orca-npm-worker'
export const NPM_PREFLIGHT_COMMAND = '__orca-npm-preflight'
export const NPM_SUPERVISOR_PROTOCOL_VERSION = 1 as const

export type NpmWorkerPreparedMessage = {
  type: 'orca:npm-worker-prepared'
  protocolVersion: typeof NPM_SUPERVISOR_PROTOCOL_VERSION
  version: string
  runtimeId: string
}

export type NpmWorkerReadyMessage = {
  type: 'orca:npm-worker-ready'
  protocolVersion: typeof NPM_SUPERVISOR_PROTOCOL_VERSION
  version: string
  runtimeId: string
}

export type NpmWorkerCommitMessage = {
  type: 'orca:npm-worker-commit'
  protocolVersion: typeof NPM_SUPERVISOR_PROTOCOL_VERSION
}

export type NpmWorkerCommitAppliedMessage = {
  type: 'orca:npm-worker-commit-applied'
  protocolVersion: typeof NPM_SUPERVISOR_PROTOCOL_VERSION
}

export type NpmUpdateFailureMessage = {
  type: 'orca:npm-update-failed'
  protocolVersion: typeof NPM_SUPERVISOR_PROTOCOL_VERSION
  requestId: string
  fromVersion: string
  targetVersion: string
  originRuntimeId: string
  reason: string
}

export type NpmUpdateSuccessMessage = {
  type: 'orca:npm-update-committed'
  protocolVersion: typeof NPM_SUPERVISOR_PROTOCOL_VERSION
  requestId: string
}

export type NpmUpdateOutcomeAppliedMessage = {
  type: 'orca:npm-update-failure-applied' | 'orca:npm-update-success-applied'
  protocolVersion: typeof NPM_SUPERVISOR_PROTOCOL_VERSION
  requestId: string
}

export type NpmUpdateActivationMessage = {
  type: 'orca:npm-update-activate'
  protocolVersion: typeof NPM_SUPERVISOR_PROTOCOL_VERSION
  requestId: string
  fromVersion: string
  targetVersion: string
  runtimeId: string
}

export type NpmWorkerStopMessage = {
  type: 'orca:npm-worker-stop'
  protocolVersion: typeof NPM_SUPERVISOR_PROTOCOL_VERSION
  signal: 'SIGINT' | 'SIGTERM'
}

export type NpmSupervisorMessage =
  | NpmWorkerPreparedMessage
  | NpmWorkerReadyMessage
  | NpmWorkerCommitMessage
  | NpmWorkerCommitAppliedMessage
  | NpmUpdateActivationMessage
  | NpmUpdateFailureMessage
  | NpmUpdateSuccessMessage
  | NpmUpdateOutcomeAppliedMessage
  | NpmWorkerStopMessage

export function parseNpmSupervisorMessage(value: unknown): NpmSupervisorMessage | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const message = value as Record<string, unknown>
  if (
    message.type === 'orca:npm-worker-commit-applied' &&
    message.protocolVersion === NPM_SUPERVISOR_PROTOCOL_VERSION
  ) {
    return message as NpmWorkerCommitAppliedMessage
  }
  if (
    message.type === 'orca:npm-worker-commit' &&
    message.protocolVersion === NPM_SUPERVISOR_PROTOCOL_VERSION
  ) {
    return message as NpmWorkerCommitMessage
  }
  if (
    message.type === 'orca:npm-worker-stop' &&
    message.protocolVersion === NPM_SUPERVISOR_PROTOCOL_VERSION &&
    (message.signal === 'SIGINT' || message.signal === 'SIGTERM')
  ) {
    return message as NpmWorkerStopMessage
  }
  if (
    (message.type === 'orca:npm-worker-prepared' || message.type === 'orca:npm-worker-ready') &&
    message.protocolVersion === NPM_SUPERVISOR_PROTOCOL_VERSION &&
    typeof message.version === 'string' &&
    isExactNpmVersion(message.version) &&
    typeof message.runtimeId === 'string' &&
    message.runtimeId.length > 0
  ) {
    return message as NpmWorkerPreparedMessage | NpmWorkerReadyMessage
  }
  if (
    message.type === 'orca:npm-update-activate' &&
    message.protocolVersion === NPM_SUPERVISOR_PROTOCOL_VERSION &&
    typeof message.requestId === 'string' &&
    message.requestId.length > 0 &&
    typeof message.fromVersion === 'string' &&
    isExactNpmVersion(message.fromVersion) &&
    typeof message.targetVersion === 'string' &&
    isExactNpmVersion(message.targetVersion) &&
    typeof message.runtimeId === 'string' &&
    message.runtimeId.length > 0
  ) {
    return message as NpmUpdateActivationMessage
  }
  if (
    (message.type === 'orca:npm-update-failure-applied' ||
      message.type === 'orca:npm-update-success-applied') &&
    message.protocolVersion === NPM_SUPERVISOR_PROTOCOL_VERSION &&
    typeof message.requestId === 'string' &&
    message.requestId.length > 0
  ) {
    return message as NpmUpdateOutcomeAppliedMessage
  }
  if (
    message.type === 'orca:npm-update-committed' &&
    message.protocolVersion === NPM_SUPERVISOR_PROTOCOL_VERSION &&
    typeof message.requestId === 'string' &&
    message.requestId.length > 0
  ) {
    return message as NpmUpdateSuccessMessage
  }
  if (
    message.type === 'orca:npm-update-failed' &&
    message.protocolVersion === NPM_SUPERVISOR_PROTOCOL_VERSION &&
    typeof message.requestId === 'string' &&
    message.requestId.length > 0 &&
    typeof message.fromVersion === 'string' &&
    isExactNpmVersion(message.fromVersion) &&
    typeof message.targetVersion === 'string' &&
    isExactNpmVersion(message.targetVersion) &&
    typeof message.originRuntimeId === 'string' &&
    message.originRuntimeId.length > 0 &&
    typeof message.reason === 'string' &&
    /^[a-z0-9_:-]+$/i.test(message.reason)
  ) {
    return message as NpmUpdateFailureMessage
  }
  return null
}

export function isNpmWorkerReadyProtocolMismatch(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false
  }
  const message = value as Record<string, unknown>
  return (
    (message.type === 'orca:npm-worker-prepared' || message.type === 'orca:npm-worker-ready') &&
    message.protocolVersion !== NPM_SUPERVISOR_PROTOCOL_VERSION
  )
}

export function notifyNpmSupervisorPrepared(version: string, runtimeId: string): Promise<void> {
  return sendToNpmSupervisorAndWait({
    type: 'orca:npm-worker-prepared',
    protocolVersion: NPM_SUPERVISOR_PROTOCOL_VERSION,
    version,
    runtimeId
  })
}

export function isExactNpmVersion(value: string): boolean {
  const match = value.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/
  )
  if (!match) {
    return false
  }
  return validSemverIdentifiers(match[4], true) && validSemverIdentifiers(match[5], false)
}

function validSemverIdentifiers(value: string | undefined, rejectLeadingZero: boolean): boolean {
  if (value === undefined) {
    return true
  }
  return value.split('.').every((identifier) => {
    if (!identifier || !/^[0-9A-Za-z-]+$/.test(identifier)) {
      return false
    }
    return !(rejectLeadingZero && /^0\d+$/.test(identifier))
  })
}

export function notifyNpmSupervisorReady(version: string, runtimeId: string): Promise<void> {
  return sendToNpmSupervisorAndWait({
    type: 'orca:npm-worker-ready',
    protocolVersion: NPM_SUPERVISOR_PROTOCOL_VERSION,
    version,
    runtimeId
  })
}

export function notifyNpmSupervisorCommitApplied(): Promise<void> {
  return sendToNpmSupervisorAndWait({
    type: 'orca:npm-worker-commit-applied',
    protocolVersion: NPM_SUPERVISOR_PROTOCOL_VERSION
  })
}

export function notifyNpmSupervisorOutcomeApplied(
  type: NpmUpdateOutcomeAppliedMessage['type'],
  requestId: string
): Promise<void> {
  return sendToNpmSupervisorAndWait({
    type,
    protocolVersion: NPM_SUPERVISOR_PROTOCOL_VERSION,
    requestId
  })
}

export function requestNpmSupervisorActivation(
  message: NpmUpdateActivationMessage,
  onDeliveryError?: () => void
): boolean {
  if (!process.send || process.connected === false) {
    return false
  }
  try {
    process.send(message, (error) => {
      if (error) {
        onDeliveryError?.()
      }
    })
    return true
  } catch {
    return false
  }
}

function sendToNpmSupervisorAndWait(message: NpmSupervisorMessage): Promise<void> {
  if (!process.send || process.connected === false) {
    return Promise.reject(new Error('npm_update_supervisor_unavailable'))
  }
  return new Promise((resolve, reject) => {
    try {
      process.send!(message, (error) => (error ? reject(error) : resolve()))
    } catch (error) {
      reject(error)
    }
  })
}
