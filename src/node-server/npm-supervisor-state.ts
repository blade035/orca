import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isExactNpmVersion } from './npm-supervisor-protocol'
import type { NpmUpdateActivationMessage } from './npm-supervisor-protocol'
import { getNpmRuntimeStatePath, NPM_RUNTIME_STATE_SCHEMA_VERSION } from './npm-runtime-paths'

export type NpmUpdateFailure = {
  requestId: string
  fromVersion: string
  targetVersion: string
  originRuntimeId: string
  reason: string
}

export type NpmSupervisorState = {
  schemaVersion: typeof NPM_RUNTIME_STATE_SCHEMA_VERSION
  activeVersion?: string
  pending?: Omit<NpmUpdateFailure, 'reason'>
  completed?: Omit<NpmUpdateFailure, 'reason'>
  failure?: NpmUpdateFailure
}

export async function readNpmSupervisorState(dataPath: string): Promise<NpmSupervisorState> {
  try {
    const parsed = JSON.parse(await readFile(getNpmRuntimeStatePath(dataPath), 'utf8'))
    return parseNpmSupervisorState(parsed) ?? emptyNpmSupervisorState()
  } catch {
    return emptyNpmSupervisorState()
  }
}

export async function writeNpmSupervisorState(
  dataPath: string,
  state: NpmSupervisorState
): Promise<void> {
  const statePath = getNpmRuntimeStatePath(dataPath)
  const temporaryPath = `${statePath}.${process.pid}.tmp`
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 })
  await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  await rename(temporaryPath, statePath)
}

export function emptyNpmSupervisorState(): NpmSupervisorState {
  return { schemaVersion: NPM_RUNTIME_STATE_SCHEMA_VERSION }
}

export async function recoverInterruptedNpmHandoff(
  dataPath: string,
  state: NpmSupervisorState
): Promise<NpmSupervisorState> {
  if (!state.pending) {
    return state
  }
  const next: NpmSupervisorState = {
    schemaVersion: state.schemaVersion,
    ...(state.activeVersion ? { activeVersion: state.activeVersion } : {}),
    ...(state.completed ? { completed: state.completed } : {}),
    failure: { ...state.pending, reason: 'npm_update_supervisor_interrupted' }
  }
  await writeNpmSupervisorState(dataPath, next)
  return next
}

export async function beginNpmHandoff(
  dataPath: string,
  state: NpmSupervisorState,
  activation: NpmUpdateActivationMessage
): Promise<NpmSupervisorState> {
  const next: NpmSupervisorState = {
    schemaVersion: state.schemaVersion,
    ...(state.activeVersion ? { activeVersion: state.activeVersion } : {}),
    ...(state.completed ? { completed: state.completed } : {}),
    pending: {
      requestId: activation.requestId,
      fromVersion: activation.fromVersion,
      targetVersion: activation.targetVersion,
      originRuntimeId: activation.runtimeId
    }
  }
  await writeNpmSupervisorState(dataPath, next)
  return next
}

export async function failNpmHandoff(
  dataPath: string,
  state: NpmSupervisorState,
  activation: NpmUpdateActivationMessage,
  reason: string
): Promise<NpmSupervisorState> {
  const next: NpmSupervisorState = {
    schemaVersion: state.schemaVersion,
    ...(state.activeVersion ? { activeVersion: state.activeVersion } : {}),
    ...(state.completed ? { completed: state.completed } : {}),
    failure: {
      requestId: activation.requestId,
      fromVersion: activation.fromVersion,
      targetVersion: activation.targetVersion,
      originRuntimeId: activation.runtimeId,
      reason
    }
  }
  await writeNpmSupervisorState(dataPath, next)
  return next
}

export async function commitNpmHandoff(
  dataPath: string,
  state: NpmSupervisorState,
  activation: NpmUpdateActivationMessage
): Promise<NpmSupervisorState> {
  const next: NpmSupervisorState = {
    schemaVersion: state.schemaVersion,
    activeVersion: activation.targetVersion,
    completed: {
      requestId: activation.requestId,
      fromVersion: activation.fromVersion,
      targetVersion: activation.targetVersion,
      originRuntimeId: activation.runtimeId
    }
  }
  await writeNpmSupervisorState(dataPath, next)
  return next
}

export async function clearActiveNpmRuntime(
  dataPath: string,
  state: NpmSupervisorState
): Promise<NpmSupervisorState> {
  const next: NpmSupervisorState = {
    schemaVersion: state.schemaVersion,
    ...(state.pending ? { pending: state.pending } : {}),
    ...(state.completed ? { completed: state.completed } : {}),
    ...(state.failure ? { failure: state.failure } : {})
  }
  await writeNpmSupervisorState(dataPath, next)
  return next
}

export function npmSupervisorStartupFailure(
  state: NpmSupervisorState
): NpmUpdateFailure | undefined {
  return state.failure
}

export function parseNpmSupervisorState(value: unknown): NpmSupervisorState | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const state = value as Record<string, unknown>
  if (state.schemaVersion !== NPM_RUNTIME_STATE_SCHEMA_VERSION) {
    return null
  }
  const activeVersion = state.activeVersion
  if (activeVersion !== undefined && !isExactNpmVersion(String(activeVersion))) {
    return null
  }
  const pending = parseAttempt(state.pending)
  const completed = parseAttempt(state.completed)
  const failure = parseFailure(state.failure)
  if (
    (state.pending !== undefined && !pending) ||
    (state.completed !== undefined && !completed) ||
    (state.failure !== undefined && !failure)
  ) {
    return null
  }
  return {
    schemaVersion: NPM_RUNTIME_STATE_SCHEMA_VERSION,
    ...(activeVersion === undefined ? {} : { activeVersion: String(activeVersion) }),
    ...(pending ? { pending } : {}),
    ...(completed ? { completed } : {}),
    ...(failure ? { failure } : {})
  }
}

function parseAttempt(value: unknown): Omit<NpmUpdateFailure, 'reason'> | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const attempt = value as Record<string, unknown>
  if (
    typeof attempt.requestId !== 'string' ||
    attempt.requestId.length === 0 ||
    typeof attempt.fromVersion !== 'string' ||
    !isExactNpmVersion(attempt.fromVersion) ||
    typeof attempt.targetVersion !== 'string' ||
    !isExactNpmVersion(attempt.targetVersion) ||
    typeof attempt.originRuntimeId !== 'string' ||
    attempt.originRuntimeId.length === 0
  ) {
    return null
  }
  return attempt as Omit<NpmUpdateFailure, 'reason'>
}

function parseFailure(value: unknown): NpmUpdateFailure | null {
  const attempt = parseAttempt(value)
  const reason = (value as Record<string, unknown> | null)?.reason
  if (!attempt || typeof reason !== 'string' || !/^[a-z0-9_:-]+$/i.test(reason)) {
    return null
  }
  return { ...attempt, reason }
}
