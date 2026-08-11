#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { disconnectDaemon, initDaemonPtyProvider } from '../main/daemon/daemon-init'
import { initDataPath, Store } from '../main/persistence'
import type { OrcaRuntimeService } from '../main/runtime/orca-runtime'
import { resolveAdvertisedPairingEndpoint } from '../main/runtime/pairing-endpoint'
import { configureRemoteServerUpdater } from '../main/runtime/remote-server-updater'
import { OrcaRuntimeRpcServer } from '../main/runtime/runtime-rpc'
import { ServeReadinessPublisher } from '../main/server/serve-readiness'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../shared/runtime-types'
import { configureNodeHostEnvironment } from './node-host-electron-facade'
import {
  createBrowserlessRuntimeComposition,
  type BrowserlessRuntimeComposition
} from './browserless-runtime-composition'
import { discoverServerPairingAddress } from './server-address-discovery'
import { resolveServerBindHost } from './server-bind-host'
import { parseServerCliArguments, renderServerHelp } from './server-cli-arguments'
import { ensureServerDataPath, resolveServerDataPath } from './server-paths'
import { configureServerProfileEnvironment } from './server-profile-environment'
import {
  acquireServerProfileProcessLock,
  ServerProfileProcessLockError
} from './server-profile-process-lock'
import { createServerWindowGraph } from './server-window-graph'
import { createNpmServerUpdater } from './npm-server-updater'
import { readNpmRuntimeVersion } from './npm-runtime-version'
import { notifyNpmSupervisorReady } from './npm-supervisor-protocol'
import { npmSupervisorStartupFailure, readNpmSupervisorState } from './npm-supervisor-state'
import { createServerShutdownCoordinator } from './server-shutdown-coordinator'
import { installServerSignalShutdown } from './server-signal-shutdown'
import { requireServerWebSocketEndpoint } from './server-websocket-readiness'

export async function runNodeServer(
  argv = process.argv.slice(2),
  options: {
    beforeRpcStart?: (runtimeId: string, signal: AbortSignal) => Promise<void>
    onSignalHandlersReady?: () => void
  } = {}
): Promise<void> {
  const args = parseServerCliArguments(argv)
  const runtimeVersion = readNpmRuntimeVersion()
  if (args.command === 'help') {
    process.stdout.write(`${renderServerHelp()}\n`)
    return
  }
  if (args.command === 'version') {
    process.stdout.write(`${runtimeVersion}\n`)
    return
  }

  const appPath = __dirname
  const dataPath = resolveServerDataPath(args.dataPath)
  configureServerProfileEnvironment(dataPath)
  ensureServerDataPath(dataPath)
  configureNodeHostEnvironment({ appPath, dataPath, version: runtimeVersion })
  process.env.ORCA_APP_VERSION = runtimeVersion
  const profileLock = await acquireServerProfileProcessLock(dataPath).catch((error: unknown) => {
    if (error instanceof ServerProfileProcessLockError && error.reason === 'already_owned') {
      process.exitCode = 3
    }
    throw error
  })
  const startupAbortController = new AbortController()
  const supervisorState = await readNpmSupervisorState(dataPath)
  const updater = createNpmServerUpdater({
    dataPath,
    initialFailure: npmSupervisorStartupFailure(supervisorState),
    signal: startupAbortController.signal
  })
  configureRemoteServerUpdater(updater)

  let store: Store | null = null
  let composition: BrowserlessRuntimeComposition | null = null
  let rpc: OrcaRuntimeRpcServer | null = null
  let startupPromise: Promise<void> | null = null
  const shutdown = createServerShutdownCoordinator(async (getRequestedExitCode) => {
    const lifecycleResults = await settleLifecycleSteps([
      () =>
        startupPromise?.then(
          () => undefined,
          () => undefined
        ) ?? Promise.resolve(),
      () => rpc?.stop() ?? Promise.resolve(),
      () => updater.stop(),
      () => composition?.stop() ?? Promise.resolve(),
      () => disconnectDaemon(),
      () => store?.flushAsync() ?? Promise.resolve()
    ])
    const lifecycleFailed = lifecycleResults.some((result) => result.status === 'rejected')
    const lockReleased = await profileLock.release().then(
      () => true,
      (error) => {
        process.stderr.write(
          `Orca server failed to release its profile lock: ${error instanceof Error ? error.message : String(error)}\n`
        )
        return false
      }
    )
    process.exitCode = lifecycleFailed || !lockReleased ? 1 : getRequestedExitCode()
  })
  installServerSignalShutdown({
    emitter: process,
    shutdown,
    exit: (exitCode) => process.exit(exitCode),
    getExitCode: () => (typeof process.exitCode === 'number' ? process.exitCode : 0),
    onSignal: () => startupAbortController.abort(),
    onForceExit: () =>
      process.stderr.write('Orca server shutdown exceeded 30 seconds; forcing exit.\n')
  })
  options.onSignalHandlersReady?.()

  try {
    initDataPath()
    store = new Store({ dataFile: join(dataPath, 'orca-data.json') })
    composition = createBrowserlessRuntimeComposition({ store, dataPath })
    const activeStore = store
    const activeComposition = composition
    const { runtime } = activeComposition
    startupPromise = (async () => {
      const { signal } = startupAbortController
      signal.throwIfAborted()
      await initDaemonPtyProvider(signal, { macosLoginSessionWatch: false })
      signal.throwIfAborted()
      await activeComposition.startAfterDaemon()
      signal.throwIfAborted()
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, createServerWindowGraph(activeStore))
      const pairingAddress = await discoverServerPairingAddress(args.pairingAddress)
      signal.throwIfAborted()
      validatePairingAddress(pairingAddress.address)
      rpc = new OrcaRuntimeRpcServer({
        runtime,
        userDataPath: dataPath,
        enableWebSocket: true,
        preferPinnedWsPort: args.port !== 0,
        wsBindHost: resolveServerBindHost(args.listenHost, pairingAddress),
        wsPort: args.port,
        webClientRoot: resolveWebClientRoot(appPath)
      })
      await options.beforeRpcStart?.(runtime.getRuntimeId(), signal)
      signal.throwIfAborted()
      await rpc.start()
      signal.throwIfAborted()
      requireServerWebSocketEndpoint(rpc.getWebSocketEndpoint())
      await publishReadiness(runtime, rpc, args, pairingAddress.address, signal)
      signal.throwIfAborted()
      if (!args.json && pairingAddress.source === 'loopback' && process.env.SSH_CONNECTION) {
        const resolvedPort = new URL(rpc.getWebSocketEndpoint()!).port
        process.stdout.write(
          `SSH tunnel (run locally with the same SSH target): ssh -L ${resolvedPort}:127.0.0.1:${resolvedPort} ${process.env.USER ?? 'user'}@<same-ssh-host>\n`
        )
      }
    })()
    await startupPromise
    await notifyNpmSupervisorReady(runtimeVersion, composition.runtime.getRuntimeId())
  } catch (error) {
    if (startupAbortController.signal.aborted) {
      await shutdown(0)
    } else {
      await shutdown(1)
      throw error
    }
  }
}

async function settleLifecycleSteps(
  steps: readonly (() => Promise<void>)[]
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = []
  for (const step of steps) {
    try {
      await step()
      results.push({ status: 'fulfilled', value: undefined })
    } catch (reason) {
      results.push({ status: 'rejected', reason })
    }
  }
  return results
}

function validatePairingAddress(address: string): void {
  const result = resolveAdvertisedPairingEndpoint('ws://127.0.0.1:6768', address)
  if (!result.ok) {
    throw new Error(result.guidance)
  }
}

function resolveWebClientRoot(appPath: string): string | undefined {
  const root = join(appPath, 'web')
  return existsSync(join(root, 'web-index.html')) ? root : undefined
}

async function publishReadiness(
  runtime: OrcaRuntimeService,
  rpc: OrcaRuntimeRpcServer,
  args: ReturnType<typeof parseServerCliArguments>,
  pairingAddress: string,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const boundEndpoint = requireServerWebSocketEndpoint(rpc.getWebSocketEndpoint())
  const advertised = resolveAdvertisedPairingEndpoint(boundEndpoint, pairingAddress)
  const pairing = args.noPairing
    ? {
        available: false as const,
        reason: 'disabled_by_operator' as const,
        guidance: 'Restart without --no-pairing to create a client pairing offer.'
      }
    : rpc.createPairingOffer({ address: pairingAddress, name: 'Orca npm server', scope: 'runtime' })
  signal.throwIfAborted()
  await new ServeReadinessPublisher().publish(
    {
      runtimeId: runtime.getRuntimeId(),
      boundEndpoint,
      advertisedEndpoint: advertised.ok ? advertised.endpoint : null,
      managedWslCliReconciliation: 'settled',
      pairing: pairing.available
        ? {
            available: true,
            url: pairing.pairingUrl,
            endpoint: pairing.endpoint,
            deviceId: pairing.deviceId,
            webClientUrl: pairing.webClientUrl,
            scope: 'runtime',
            qr: null
          }
        : pairing
    },
    { mode: args.json ? 'json' : 'human' },
    signal
  )
}

export function reportNodeServerFailure(error: unknown): void {
  process.stderr.write(
    `Orca server failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  )
  process.exitCode ??= 1
}
