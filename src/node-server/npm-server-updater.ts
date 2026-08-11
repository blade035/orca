import { randomUUID } from 'node:crypto'
import { compareAppVersions } from '../shared/app-version'
import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot
} from '../shared/remote-server-update'
import { REMOTE_SERVER_SAFE_INSTALL_ACK_CAPABILITY } from '../shared/remote-server-update'
import type { RemoteServerUpdaterRequest } from '../main/runtime/remote-server-updater'
import type { UpdateCheckOptions, UpdateStatus } from '../shared/types'
import { ensurePinnedNpmRuntime, verifyPinnedNpmRuntime } from './npm-pinned-runtime'
import { runNpmCommand } from './npm-process-runner'
import { readNpmRuntimeVersion } from './npm-runtime-version'
import { classifyNpmCommandFailure } from './npm-update-error-classification'
import {
  NPM_SUPERVISOR_PROTOCOL_VERSION,
  isExactNpmVersion,
  requestNpmSupervisorActivation,
  type NpmUpdateFailureMessage,
  type NpmUpdateSuccessMessage
} from './npm-supervisor-protocol'
import {
  readNpmSupervisorState,
  writeNpmSupervisorState,
  type NpmUpdateFailure
} from './npm-supervisor-state'

const REGISTRY_CHECK_TIMEOUT_MS = 60_000
const INSTALL_ACKNOWLEDGEMENT_TIMEOUT_MS = 2 * 60_000
let activationFailureReceiver: ((failure: NpmUpdateFailureMessage) => void) | null = null
let activationSuccessReceiver: ((success: NpmUpdateSuccessMessage) => void) | null = null

type NpmServerUpdaterOptions = {
  dataPath: string
  initialFailure?: NpmUpdateFailure
  signal?: AbortSignal
}

export function createNpmServerUpdater(options: NpmServerUpdaterOptions) {
  const runtimeVersion = readNpmRuntimeVersion()
  let status: UpdateStatus = options.initialFailure
    ? { state: 'error', message: options.initialFailure.reason, userInitiated: true }
    : { state: 'idle' }
  let snapshotRuntimeId: string | null = options.initialFailure?.originRuntimeId ?? null
  let operation: Promise<void> | null = null
  let installResult: RemoteServerUpdateInstallResult | null = null
  let pendingActivation: Parameters<typeof requestNpmSupervisorActivation>[0] | null = null
  let activationRequestId: string | null = null
  let activationRequesterId: string | null = null
  let completedAcknowledgementId: string | null = null
  let acknowledgementTimer: ReturnType<typeof setTimeout> | null = null

  activationFailureReceiver = (failure) => {
    if (activationRequestId !== null && failure.requestId !== activationRequestId) {
      return
    }
    activationRequestId = failure.requestId
    snapshotRuntimeId = failure.originRuntimeId
    clearAcknowledgementTimer()
    status = { state: 'error', message: failure.reason, userInitiated: true }
  }
  activationSuccessReceiver = (success) => {
    clearAcknowledgementTimer()
    completedAcknowledgementId = success.requestId
  }

  const getSnapshot = (
    runtimeId: string,
    request?: RemoteServerUpdaterRequest
  ): RemoteServerUpdaterSnapshot => {
    activateAfterInstallResponse(request?.acknowledgementId, request?.requesterId)
    const automatic =
      process.send !== undefined &&
      process.connected !== false &&
      request?.clientCapabilities?.includes(REMOTE_SERVER_SAFE_INSTALL_ACK_CAPABILITY) === true
    return {
      appVersion: runtimeVersion,
      runtimeId: snapshotRuntimeId ?? runtimeId,
      ...(completedAcknowledgementId ? { completedAcknowledgementId } : {}),
      support: {
        installMode: 'supervised-headless-serve',
        automatic,
        reason: automatic ? 'available' : 'manual-service-update-required'
      },
      status
    }
  }

  const check = (runtimeId: string, checkOptions?: UpdateCheckOptions) => {
    if (pendingActivation) {
      throw new Error('remote_update_activation_pending')
    }
    if (operation) {
      return getSnapshot(runtimeId)
    }
    snapshotRuntimeId = null
    installResult = null
    pendingActivation = null
    activationRequestId = null
    activationRequesterId = null
    completedAcknowledgementId = null
    status = { state: 'checking', userInitiated: true }
    operation = resolvePublishedVersion(options.dataPath, checkOptions, options.signal)
      .then(async (version) => {
        await clearRecordedFailure(options.dataPath)
        status =
          compareAppVersions(runtimeVersion, version) < 0
            ? { state: 'available', version, changelog: null }
            : { state: 'not-available', userInitiated: true }
      })
      .catch((error: unknown) => {
        status = { state: 'error', message: safeUpdateError(error), userInitiated: true }
      })
      .finally(() => {
        operation = null
      })
    return getSnapshot(runtimeId)
  }

  const download = (runtimeId: string) => {
    if (pendingActivation) {
      throw new Error('remote_update_activation_pending')
    }
    if (operation) {
      return getSnapshot(runtimeId)
    }
    if (status.state !== 'available') {
      throw new Error('remote_update_not_available')
    }
    const version = status.version
    status = { state: 'downloading', percent: 0, version }
    operation = ensurePinnedNpmRuntime(options.dataPath, version, options.signal)
      .then(() => {
        status = { state: 'downloaded', version }
      })
      .catch((error: unknown) => {
        status = { state: 'error', message: safeUpdateError(error), userInitiated: true }
      })
      .finally(() => {
        operation = null
      })
    return getSnapshot(runtimeId)
  }

  const install = (
    runtimeId: string,
    clientCapabilities?: readonly string[],
    requesterId?: string
  ): RemoteServerUpdateInstallResult => {
    if (installResult) {
      requireSafeInstallRequester(clientCapabilities, requesterId)
      if (requesterId !== activationRequesterId) {
        throw new Error('remote_update_activation_pending')
      }
      return installResult
    }
    if (operation || status.state !== 'downloaded') {
      throw new Error('remote_update_not_downloaded')
    }
    requireSafeInstallRequester(clientCapabilities, requesterId)
    const targetVersion = status.version
    const requestId = randomUUID()
    pendingActivation = {
      type: 'orca:npm-update-activate',
      protocolVersion: NPM_SUPERVISOR_PROTOCOL_VERSION,
      requestId,
      fromVersion: runtimeVersion,
      targetVersion,
      runtimeId
    }
    activationRequestId = requestId
    activationRequesterId = requesterId
    acknowledgementTimer = setTimeout(() => {
      pendingActivation = null
      installResult = null
      activationRequestId = null
      activationRequesterId = null
      status = {
        state: 'error',
        message: 'npm_update_acknowledgement_timeout',
        userInitiated: true
      }
      acknowledgementTimer = null
    }, INSTALL_ACKNOWLEDGEMENT_TIMEOUT_MS)
    acknowledgementTimer.unref?.()
    installResult = {
      accepted: true,
      fromVersion: runtimeVersion,
      targetVersion,
      runtimeId,
      acknowledgementId: requestId
    }
    return installResult
  }

  function activateAfterInstallResponse(acknowledgementId?: string, requesterId?: string): void {
    const activation = pendingActivation
    if (
      !activation ||
      acknowledgementId !== activation.requestId ||
      requesterId !== activationRequesterId
    ) {
      return
    }
    pendingActivation = null
    clearAcknowledgementTimer()
    const deliveryFailed = (): void => {
      if (activationRequestId !== activation.requestId) {
        return
      }
      installResult = null
      status = {
        state: 'error',
        message: 'npm_update_supervisor_unavailable',
        userInitiated: true
      }
    }
    if (!requestNpmSupervisorActivation(activation, deliveryFailed)) {
      installResult = null
      status = {
        state: 'error',
        message: 'npm_update_supervisor_unavailable',
        userInitiated: true
      }
    }
  }

  const stop = async (): Promise<void> => {
    clearAcknowledgementTimer()
    await operation?.catch(() => undefined)
  }

  return { getSnapshot, check, download, install, stop }

  function clearAcknowledgementTimer(): void {
    if (acknowledgementTimer) {
      clearTimeout(acknowledgementTimer)
      acknowledgementTimer = null
    }
  }

  function requireSafeInstallRequester(
    clientCapabilities?: readonly string[],
    requesterId?: string
  ): asserts requesterId is string {
    if (!clientCapabilities?.includes(REMOTE_SERVER_SAFE_INSTALL_ACK_CAPABILITY)) {
      throw new Error('remote_update_client_upgrade_required')
    }
    if (!requesterId) {
      throw new Error('remote_update_client_identity_required')
    }
  }
}

export function reportNpmSupervisorActivationFailure(failure: NpmUpdateFailureMessage): void {
  activationFailureReceiver?.(failure)
}

export function reportNpmSupervisorActivationSuccess(success: NpmUpdateSuccessMessage): void {
  activationSuccessReceiver?.(success)
}

async function resolvePublishedVersion(
  dataPath: string,
  options?: UpdateCheckOptions,
  signal?: AbortSignal
): Promise<string> {
  const requested = options?.targetVersion?.trim()
  if (requested && !isExactNpmVersion(requested)) {
    throw new Error('npm_update_invalid_exact_version')
  }
  if (requested && (await verifyPinnedNpmRuntime(dataPath, requested))) {
    return requested
  }
  const selector = requested ?? (options?.includePrerelease ? 'rc' : 'latest')
  const result = await runNpmCommand(
    ['view', `@stablyai/orca@${selector}`, 'version', '--json'],
    REGISTRY_CHECK_TIMEOUT_MS,
    signal
  )
  if (result.code !== 0) {
    throw new Error(classifyNpmCommandFailure(result.stderr, 'registry'))
  }
  const parsed = JSON.parse(result.stdout.trim()) as unknown
  const version = Array.isArray(parsed) ? parsed.at(-1) : parsed
  if (typeof version !== 'string' || !isExactNpmVersion(version)) {
    throw new Error('npm_update_registry_version_invalid')
  }
  if (requested && version !== requested) {
    throw new Error('npm_update_registry_version_mismatch')
  }
  return version
}

async function clearRecordedFailure(dataPath: string): Promise<void> {
  const state = await readNpmSupervisorState(dataPath)
  if (!state.failure) {
    return
  }
  const { failure: _failure, ...next } = state
  await writeNpmSupervisorState(dataPath, next)
}

function safeUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/^[a-z0-9_:-]+$/i.test(message)) {
    return message
  }
  return 'npm_update_failed'
}
