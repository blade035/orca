import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { decodePairingOffer, type PairingOffer } from '../../src/shared/pairing'
import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot
} from '../../src/shared/remote-server-update'
import { sendRemoteRuntimeRequest } from '../../src/shared/remote-runtime-client'
import type { RuntimeStatus } from '../../src/shared/runtime-types'
import {
  assertDaemonIdentity,
  makePinnedWorkerFailAfterPreflight,
  nextPatchVersion,
  observeReplacementReadiness,
  preseedPinnedRuntime,
  readDaemonIdentity,
  rewritePinnedManifestVersion,
  type DaemonIdentity,
  type ReadinessObserver,
  type TerminalIdentity
} from './node-server-update-package-fixture'
import { reattachTerminal, sendAndObserveMarker } from './node-server-safe-update-terminal-oracle'

export async function verifyPackagedNpmSafeUpdate(options: {
  cliPath: string
  dataPath: string
  currentVersion: string
  pairing: PairingOffer
  server: ChildProcess
  serverStderr: string[]
  terminal: TerminalIdentity
}): Promise<{
  pairing: PairingOffer
  runtimeId: string
  terminal: TerminalIdentity
  version: string
}> {
  const readiness = observeReplacementReadiness(
    options.server,
    options.dataPath,
    options.serverStderr
  )
  const daemonBefore = readDaemonIdentity(options.dataPath)
  const successVersion = nextPatchVersion(options.currentVersion, 1)

  try {
    preseedPinnedRuntime(options.cliPath, options.dataPath, successVersion)
    const successful = await driveSuccessfulUpdate({
      dataPath: options.dataPath,
      expectedDaemon: daemonBefore,
      fromPairing: options.pairing,
      readiness,
      targetVersion: successVersion,
      terminal: options.terminal
    })
    const failureVersion = nextPatchVersion(options.currentVersion, 2)
    preseedPinnedRuntime(options.cliPath, options.dataPath, failureVersion)
    await driveRejectedPreflight({
      dataPath: options.dataPath,
      expectedDaemon: daemonBefore,
      fromPairing: successful.pairing,
      targetVersion: failureVersion,
      terminal: successful.terminal
    })
    const rollbackFailureVersion = nextPatchVersion(options.currentVersion, 3)
    preseedPinnedRuntime(options.cliPath, options.dataPath, rollbackFailureVersion)
    const rolledBack = await driveFailedUpdate({
      dataPath: options.dataPath,
      expectedDaemon: daemonBefore,
      fromPairing: successful.pairing,
      readiness,
      rollbackVersion: successVersion,
      targetVersion: rollbackFailureVersion,
      terminal: successful.terminal
    })
    process.stdout.write('Packaged npm safe-update oracle passed\n')
    return { ...rolledBack, version: successVersion }
  } finally {
    readiness.dispose()
  }
}

async function driveRejectedPreflight(options: {
  dataPath: string
  expectedDaemon: DaemonIdentity
  fromPairing: PairingOffer
  targetVersion: string
  terminal: TerminalIdentity
}): Promise<void> {
  await prepareUpdate(options.fromPairing, options.targetVersion)
  rewritePinnedManifestVersion(
    options.dataPath,
    options.targetVersion,
    nextPatchVersion(options.targetVersion, 1)
  )
  const install = await call<RemoteServerUpdateInstallResult>(
    options.fromPairing,
    'updater.install'
  )
  assertInstallTarget(install, options.targetVersion)
  await acknowledgeInstall(options.fromPairing, install)
  const updater = await waitForUpdaterError(
    options.fromPairing,
    'npm_update_preflight_version_mismatch'
  )
  const status = await call<RuntimeStatus>(options.fromPairing, 'status.get')
  assert(status.runtimeId === install.runtimeId, 'failed preflight replaced the healthy worker')
  assert(updater.runtimeId === install.runtimeId, 'failed preflight lost its runtime identity')
  assertDaemonIdentity(options.dataPath, options.expectedDaemon)
  await sendAndObserveMarker(
    options.fromPairing,
    options.terminal.handle,
    `orca-preflight-${randomUUID()}`
  )
}

async function driveSuccessfulUpdate(options: {
  dataPath: string
  expectedDaemon: DaemonIdentity
  fromPairing: PairingOffer
  readiness: ReadinessObserver
  targetVersion: string
  terminal: TerminalIdentity
}): Promise<{ pairing: PairingOffer; runtimeId: string; terminal: TerminalIdentity }> {
  await prepareUpdate(options.fromPairing, options.targetVersion)
  const install = await call<RemoteServerUpdateInstallResult>(
    options.fromPairing,
    'updater.install'
  )
  assertInstallTarget(install, options.targetVersion)
  await acknowledgeInstall(options.fromPairing, install)

  const ready = await options.readiness.next()
  const pairing = decodePairingOffer(ready.pairing.url)
  const status = await verifyReplacementStatus(pairing, ready.runtimeId, options.targetVersion)
  assert(install.acknowledgementId, 'successful activation lost its acknowledgement receipt')
  await waitForCommittedUpdate(pairing, install.acknowledgementId)
  assert(status.runtimeId !== install.runtimeId, 'update retained the old runtime identity')
  assertDaemonIdentity(options.dataPath, options.expectedDaemon)
  const terminal = await reattachTerminal(pairing, options.terminal)
  await sendAndObserveMarker(pairing, terminal.handle, `orca-update-${randomUUID()}`)
  return { pairing, runtimeId: status.runtimeId, terminal }
}

async function waitForCommittedUpdate(
  pairing: PairingOffer,
  acknowledgementId: string
): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const snapshot = await call<RemoteServerUpdaterSnapshot>(pairing, 'updater.getStatus')
    if (snapshot.status.state === 'error') {
      throw new Error(`updater entered error state: ${snapshot.status.message}`)
    }
    if (snapshot.completedAcknowledgementId === acknowledgementId) {
      return
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error('updater never acknowledged its durable commit')
}

async function driveFailedUpdate(options: {
  dataPath: string
  expectedDaemon: DaemonIdentity
  fromPairing: PairingOffer
  readiness: ReadinessObserver
  rollbackVersion: string
  targetVersion: string
  terminal: TerminalIdentity
}): Promise<{ pairing: PairingOffer; runtimeId: string; terminal: TerminalIdentity }> {
  await prepareUpdate(options.fromPairing, options.targetVersion)
  makePinnedWorkerFailAfterPreflight(options.dataPath, options.targetVersion)
  const install = await call<RemoteServerUpdateInstallResult>(
    options.fromPairing,
    'updater.install'
  )
  assertInstallTarget(install, options.targetVersion)
  await acknowledgeInstall(options.fromPairing, install)

  const rollbackReady = await options.readiness.next()
  const pairing = decodePairingOffer(rollbackReady.pairing.url)
  const status = await verifyReplacementStatus(
    pairing,
    rollbackReady.runtimeId,
    options.rollbackVersion
  )
  assert(
    status.runtimeId !== install.runtimeId,
    'rollback retained the originating runtime identity'
  )
  const updater = await call<RemoteServerUpdaterSnapshot>(pairing, 'updater.getStatus')
  assert(updater.runtimeId === install.runtimeId, 'rollback lost the originating update identity')
  assert(
    updater.status.state === 'error' &&
      updater.status.message === 'npm_update_worker_exited_before_ready',
    'rollback did not surface the candidate readiness failure'
  )
  assertDaemonIdentity(options.dataPath, options.expectedDaemon)
  const terminal = await reattachTerminal(pairing, options.terminal)
  await sendAndObserveMarker(pairing, terminal.handle, `orca-rollback-${randomUUID()}`)
  return { pairing, runtimeId: status.runtimeId, terminal }
}

async function waitForUpdaterError(
  pairing: PairingOffer,
  expectedMessage: string
): Promise<RemoteServerUpdaterSnapshot> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const snapshot = await call<RemoteServerUpdaterSnapshot>(pairing, 'updater.getStatus')
    if (snapshot.status.state === 'error') {
      assert(snapshot.status.message === expectedMessage, 'updater reported the wrong failure')
      return snapshot
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error('updater never reported its activation failure')
}

async function prepareUpdate(pairing: PairingOffer, targetVersion: string): Promise<void> {
  await call(pairing, 'updater.check', { targetVersion })
  await waitForUpdaterState(pairing, 'available', targetVersion)
  await call(pairing, 'updater.download')
  await waitForUpdaterState(pairing, 'downloaded', targetVersion)
}

async function waitForUpdaterState(
  pairing: PairingOffer,
  expectedState: 'available' | 'downloaded',
  expectedVersion: string
): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const snapshot = await call<RemoteServerUpdaterSnapshot>(pairing, 'updater.getStatus')
    if (snapshot.status.state === 'error') {
      throw new Error(`updater entered error state: ${snapshot.status.message}`)
    }
    if (snapshot.status.state === expectedState) {
      assert(
        snapshot.status.version === expectedVersion,
        'updater selected the wrong exact version'
      )
      return
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`updater never reached ${expectedState}`)
}

async function verifyReplacementStatus(
  pairing: PairingOffer,
  expectedRuntimeId: string,
  expectedVersion: string
): Promise<RuntimeStatus> {
  const status = await call<RuntimeStatus>(pairing, 'status.get')
  assert(status.runtimeId === expectedRuntimeId, 'replacement readiness named the wrong runtime')
  assert(status.appVersion === expectedVersion, 'replacement did not run the exact target version')
  return status
}

function assertInstallTarget(
  install: RemoteServerUpdateInstallResult,
  expectedVersion: string
): void {
  assert(install.accepted, 'supervisor rejected the update activation')
  assert(install.targetVersion === expectedVersion, 'activation selected the wrong exact version')
  assert(install.acknowledgementId, 'activation did not return a safe acknowledgement receipt')
}

async function acknowledgeInstall(
  pairing: PairingOffer,
  install: RemoteServerUpdateInstallResult
): Promise<void> {
  await call(pairing, 'updater.getStatus', {
    acknowledgementId: install.acknowledgementId
  }).catch(() => undefined)
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
