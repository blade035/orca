import { isArtifactSharingEnabled } from '../shared/artifact-sharing-gate'
import { getPreferredPairingOffer } from '../shared/runtime-environments'
import { resolveEnvironment } from '../shared/runtime-environment-store'
import { agentHookServer } from '../main/agent-hooks/server'
import { isAgentStatusHooksEnabled } from '../main/agent-hooks/managed-agent-hook-controls'
import { ArtifactCloudService } from '../main/artifacts/artifact-cloud-service'
import { AutomationService } from '../main/automations/service'
import { ClaudeAccountService } from '../main/claude-accounts/service'
import { normalizeClaudeRuntimeSelection } from '../main/claude-accounts/runtime-selection'
import { ClaudeRuntimeAuthService } from '../main/claude-accounts/runtime-auth-service'
import { prepareLegacySharedCodexSessionResume } from '../main/codex/codex-legacy-session-resume'
import { resolveHostCodexSessionSourceHome } from '../main/codex/codex-session-source-home'
import { CodexAccountService } from '../main/codex-accounts/service'
import { normalizeCodexRuntimeSelection } from '../main/codex-accounts/runtime-selection'
import { CodexRuntimeHomeService } from '../main/codex-accounts/runtime-home-service'
import { getDaemonProvider } from '../main/daemon/daemon-init'
import { callRuntimeEnvironment } from '../main/ipc/runtime-environment-transport-routing'
import {
  clearProviderPtyState,
  getLocalPtyProvider,
  getSshPtyProvider,
  registerHeadlessPtyRuntime
} from '../main/ipc/pty'
import type { Store } from '../main/persistence'
import { createAccountRuntimeTargetSettingsSync } from '../main/rate-limits/account-runtime-target-sync'
import { getInitialClaudeRateLimitTarget } from '../main/rate-limits/claude-rate-limit-target'
import { getInitialCodexRateLimitTarget } from '../main/rate-limits/codex-rate-limit-target'
import { RateLimitService } from '../main/rate-limits/service'
import { loadAgentSessionClaimSigner } from '../main/runtime/agent-session-claim-identity'
import {
  fingerprintOrchestrationPeer,
  type OrchestrationEnvironmentTransport
} from '../main/runtime/orchestration/environment-transport'
import { OrcaRuntimeService } from '../main/runtime/orca-runtime'
import { createBrowserlessAutomationDispatcher } from './browserless-automation-dispatcher'

export type BrowserlessRuntimeComposition = {
  runtime: OrcaRuntimeService
  startAfterDaemon(): Promise<void>
  stop(): Promise<void>
}

export function createBrowserlessRuntimeComposition(args: {
  store: Store
  dataPath: string
}): BrowserlessRuntimeComposition {
  const { store, dataPath } = args
  const rateLimits = new RateLimitService()
  const codexRuntimeHome = new CodexRuntimeHomeService(store)
  const claudeRuntimeAuth = new ClaudeRuntimeAuthService(store)
  const codexAccounts = new CodexAccountService(store, rateLimits, codexRuntimeHome)
  const claudeAccounts = new ClaudeAccountService(store, rateLimits, claudeRuntimeAuth)
  const stopAccountRuntimeTargetSync = configureAccountServices(
    store,
    rateLimits,
    codexRuntimeHome,
    claudeRuntimeAuth
  )

  const runtime = new OrcaRuntimeService(store, undefined, {
    agentSessionClaimSigner: loadAgentSessionClaimSigner(dataPath, dataPath),
    canRecoverPersistentLocalPtys: () => getDaemonProvider() !== null,
    getLocalProvider: () => getLocalPtyProvider(),
    getSshProvider: (connectionId) => getSshPtyProvider(connectionId),
    onPtyStopped: clearProviderPtyState,
    getDesktopWindowStatus: () => 'blocked',
    onTerminalAgentStatus: (event) => agentHookServer.ingestTerminalStatus(event),
    getAgentStatusSnapshot: () =>
      agentHookServer.getStatusSnapshot().filter((entry) => entry.providerSessionOnly !== true),
    getAgentProviderSessionSnapshot: () => agentHookServer.getStatusSnapshot(),
    getAgentProviderSessionRowsForPane: (paneKey) =>
      agentHookServer.getStatusSnapshotForPane(paneKey),
    attestAgentHookCompatibilityAuthority: (candidate) =>
      agentHookServer.attestCompatibilityAuthority(candidate),
    retireAgentHookCompatibilityAuthority: (paneKey) =>
      agentHookServer.retirePaneAuthority(paneKey),
    getAdditionalAiVaultCodexHomePaths: () =>
      codexRuntimeHome.getHostCodexHomePathsForSessionDiscovery(),
    prepareAiVaultSessionResume: (resumeArgs) =>
      prepareLegacySharedCodexSessionResume(resumeArgs, {
        isHostSystemDefaultRealHome: () => codexRuntimeHome.isHostSystemDefaultRealHome(),
        getSelectedHostAccountCodexHomePath: () =>
          codexRuntimeHome.getSelectedHostAccountCodexHomePath(),
        systemCodexHomePath: resolveHostCodexSessionSourceHome(store.getSettings())
      }),
    buildAgentHookPtyEnv: () =>
      isAgentStatusHooksEnabled(store.getSettings()) ? agentHookServer.buildPtyEnv() : {},
    orchestrationEnvironmentTransport: createOrchestrationEnvironmentTransport(dataPath)
  })
  runtime.prepareLegacyWorkerTerminalRecovery()

  const automations = new AutomationService(store, {
    allowRemoteHostScheduling: true,
    headlessDispatcher: createBrowserlessAutomationDispatcher(runtime)
  })
  runtime.setAutomationService(automations)
  runtime.setArtifactService(
    new ArtifactCloudService(dataPath, () => isArtifactSharingEnabled(store.getSettings()))
  )
  runtime.setAccountServices({ claudeAccounts, codexAccounts, rateLimits })
  runtime.setCommitMessageAgentEnvironmentResolvers({
    prepareForCodexLaunch: (target) => codexRuntimeHome.prepareForCodexLaunch(target),
    prepareForClaudeLaunch: (target) => claudeRuntimeAuth.prepareForClaudeLaunch(target)
  })

  let started = false
  let stopPromise: Promise<void> | null = null
  const stopOwnedServices = (): Promise<void> => {
    if (!stopPromise) {
      stopPromise = settleBrowserlessOwnedServiceStops([
        () => automations.stopAndDrain(),
        () => rateLimits.stop(),
        stopAccountRuntimeTargetSync,
        () => agentHookServer.setClaudeStatusLineListener(null),
        () => agentHookServer.stopAndWait()
      ])
    }
    return stopPromise
  }
  return {
    runtime,
    async startAfterDaemon(): Promise<void> {
      if (started) {
        return
      }
      if (stopPromise) {
        throw new Error('The browserless runtime composition is already stopped.')
      }
      started = true
      try {
        if (isAgentStatusHooksEnabled(store.getSettings())) {
          await agentHookServer.start({ env: 'production', userDataPath: dataPath })
        }
        registerHeadlessPtyRuntime(
          runtime,
          (target, launchEnv, context) =>
            codexRuntimeHome.prepareForCodexLaunch(target, launchEnv, {
              unavailableManagedHomePath: context?.unavailableManagedHomePath
            }),
          () => store.getSettings(),
          (target) => claudeRuntimeAuth.prepareForClaudeLaunch(target),
          store
        )
        await runtime.refreshRestoredOrchestrationAuthority()
        await runtime.reconcileLegacyWorkerTerminals()
        rateLimits.start({ fetchImmediately: false })
        automations.start()
      } catch (error) {
        started = false
        try {
          await stopOwnedServices()
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Browserless runtime startup and cleanup both failed'
          )
        }
        throw error
      }
    },
    async stop(): Promise<void> {
      await stopOwnedServices()
    }
  }
}

async function settleBrowserlessOwnedServiceStops(
  stops: readonly (() => void | Promise<void>)[]
): Promise<void> {
  const failures: unknown[] = []
  for (const stop of stops) {
    try {
      await stop()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Browserless owned service shutdown failed')
  }
}

function configureAccountServices(
  store: Store,
  rateLimits: RateLimitService,
  codexRuntimeHome: CodexRuntimeHomeService,
  claudeRuntimeAuth: ClaudeRuntimeAuthService
): () => void {
  rateLimits.setCodexHomePathResolver((target) => codexRuntimeHome.prepareForRateLimitFetch(target))
  rateLimits.setClaudeAuthPreparationResolver((target) =>
    claudeRuntimeAuth.prepareForRateLimitFetch(target)
  )
  rateLimits.setCodexFetchTarget(getInitialCodexRateLimitTarget(store.getSettings()))
  rateLimits.setClaudeFetchTarget(getInitialClaudeRateLimitTarget(store.getSettings()))
  configureInactiveAccountResolvers(store, rateLimits)
  const syncTargets = createAccountRuntimeTargetSettingsSync(rateLimits, store.getSettings())
  const stopTargetSync = store.onSettingsChanged((updates, settings) => {
    void syncTargets(updates, settings).catch((error) =>
      console.warn('[rate-limits] Failed to apply account runtime target:', error)
    )
  })
  agentHookServer.setClaudeStatusLineListener((event) => {
    rateLimits.ingestLiveClaudeRateLimits(event)
  })
  return stopTargetSync
}

function configureInactiveAccountResolvers(store: Store, rateLimits: RateLimitService): void {
  rateLimits.setInactiveClaudeAccountsResolver(() => {
    const settings = store.getSettings()
    const selection = normalizeClaudeRuntimeSelection(settings)
    const activeIds = new Set([selection.host, ...Object.values(selection.wsl)].filter(Boolean))
    return settings.claudeManagedAccounts
      .filter((account) => !activeIds.has(account.id))
      .map((account) => ({
        id: account.id,
        managedAuthPath: account.managedAuthPath,
        managedAuthRuntime: account.managedAuthRuntime,
        wslDistro: account.wslDistro,
        wslLinuxAuthPath: account.wslLinuxAuthPath
      }))
  })
  rateLimits.setInactiveCodexAccountsResolver(() => {
    const settings = store.getSettings()
    const selection = normalizeCodexRuntimeSelection(settings)
    const activeIds = new Set([selection.host, ...Object.values(selection.wsl)].filter(Boolean))
    return settings.codexManagedAccounts
      .filter((account) => !activeIds.has(account.id))
      .map((account) => ({ id: account.id, managedHomePath: account.managedHomePath }))
  })
}

function createOrchestrationEnvironmentTransport(
  dataPath: string
): OrchestrationEnvironmentTransport {
  return {
    resolve: (selector) => {
      const environment = resolveEnvironment(dataPath, selector)
      const pairing = getPreferredPairingOffer(environment)
      return {
        environmentId: environment.id,
        name: environment.name,
        peerFingerprint: fingerprintOrchestrationPeer(pairing.publicKeyB64)
      }
    },
    call: (selector, method, params, timeoutMs, envelope) =>
      callRuntimeEnvironment(dataPath, selector, method, params, timeoutMs, undefined, envelope)
  }
}
