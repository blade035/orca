#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import packageJson from '../../package.json' with { type: 'json' }
import {
  disconnectDaemon,
  getDaemonProvider,
  initDaemonPtyProvider
} from '../main/daemon/daemon-init'
import { getLocalPtyProvider, registerHeadlessPtyRuntime } from '../main/ipc/pty'
import { initDataPath, Store } from '../main/persistence'
import { OrcaRuntimeService } from '../main/runtime/orca-runtime'
import { resolveAdvertisedPairingEndpoint } from '../main/runtime/pairing-endpoint'
import { OrcaRuntimeRpcServer } from '../main/runtime/runtime-rpc'
import { ServeReadinessPublisher } from '../main/server/serve-readiness'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../shared/runtime-types'
import { configureNodeHostEnvironment } from './node-host-electron-facade'
import { discoverServerPairingAddress } from './server-address-discovery'
import { parseServerCliArguments, renderServerHelp } from './server-cli-arguments'
import { ensureServerDataPath, resolveServerDataPath } from './server-paths'
import { createServerWindowGraph } from './server-window-graph'

async function main(): Promise<void> {
  const args = parseServerCliArguments(process.argv.slice(2))
  if (args.command === 'help') {
    process.stdout.write(`${renderServerHelp()}\n`)
    return
  }
  if (args.command === 'version') {
    process.stdout.write(`${packageJson.version}\n`)
    return
  }

  const appPath = __dirname
  const dataPath = resolveServerDataPath(args.dataPath)
  ensureServerDataPath(dataPath)
  configureNodeHostEnvironment({ appPath, dataPath, version: packageJson.version })
  initDataPath()

  const store = new Store({ dataFile: join(dataPath, 'orca-data.json') })
  const runtime = new OrcaRuntimeService(store, undefined, {
    canRecoverPersistentLocalPtys: () => getDaemonProvider() !== null,
    getDesktopWindowStatus: () => 'blocked',
    getLocalProvider: () => getLocalPtyProvider()
  })

  let rpc: OrcaRuntimeRpcServer | null = null
  let shuttingDown = false
  const shutdown = async (exitCode: number): Promise<void> => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    await Promise.allSettled([
      rpc?.stop() ?? Promise.resolve(),
      disconnectDaemon(),
      store.flushAsync()
    ])
    process.exitCode = exitCode
  }

  try {
    await initDaemonPtyProvider(undefined, { macosLoginSessionWatch: false })
    registerHeadlessPtyRuntime(runtime, undefined, () => store.getSettings(), undefined, store)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, createServerWindowGraph(store))
    const pairingAddress = await discoverServerPairingAddress(args.pairingAddress)
    validatePairingAddress(pairingAddress.address)
    rpc = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: dataPath,
      enableWebSocket: true,
      preferPinnedWsPort: args.port !== 0,
      wsBindHost:
        args.listenHost ??
        (pairingAddress.source === 'tailscale'
          ? pairingAddress.address
          : pairingAddress.source === 'explicit'
            ? '0.0.0.0'
            : '127.0.0.1'),
      wsPort: args.port,
      webClientRoot: resolveWebClientRoot(appPath)
    })
    await rpc.start()
    await publishReadiness(runtime, rpc, args, pairingAddress.address)
    if (!args.json && pairingAddress.source === 'loopback' && process.env.SSH_CONNECTION) {
      const resolvedPort = new URL(rpc.getWebSocketEndpoint()!).port
      process.stdout.write(
        `SSH tunnel: ssh -L ${resolvedPort}:127.0.0.1:${resolvedPort} ${process.env.USER ?? 'user'}@<server>\n`
      )
    }
    process.once('SIGINT', () => void shutdown(0).then(() => process.exit(0)))
    process.once('SIGTERM', () => void shutdown(0).then(() => process.exit(0)))
  } catch (error) {
    await shutdown(1)
    throw error
  }
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
  pairingAddress: string
): Promise<void> {
  const boundEndpoint = rpc.getWebSocketEndpoint()
  const advertised = boundEndpoint
    ? resolveAdvertisedPairingEndpoint(boundEndpoint, pairingAddress)
    : null
  const pairing = args.noPairing
    ? {
        available: false as const,
        reason: 'disabled_by_operator' as const,
        guidance: 'Restart without --no-pairing to create a client pairing offer.'
      }
    : rpc.createPairingOffer({ address: pairingAddress, name: 'Orca npm server', scope: 'runtime' })
  await new ServeReadinessPublisher().publish(
    {
      runtimeId: runtime.getRuntimeId(),
      boundEndpoint,
      advertisedEndpoint: advertised?.ok ? advertised.endpoint : null,
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
    { mode: args.json ? 'json' : 'human' }
  )
}

void main().catch((error) => {
  process.stderr.write(
    `Orca server failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  )
  process.exitCode = 1
})
