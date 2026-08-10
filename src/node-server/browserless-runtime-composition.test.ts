import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../main/persistence'

const state = vi.hoisted(() => {
  const calls: string[] = []
  const signerKeyIds: string[] = []
  const inactiveResolvers = {
    claude: null as (() => unknown) | null,
    codex: null as (() => unknown) | null
  }
  const normalizationCalls = { claude: 0, codex: 0 }
  const stopErrors = {
    automation: null as Error | null,
    rateLimits: null as Error | null,
    targetSync: null as Error | null,
    hook: null as Error | null
  }

  class Runtime {
    private accountServices: {
      claudeAccounts: { listAccounts(): unknown }
      codexAccounts: { listAccounts(): unknown }
      rateLimits: { getState(): unknown }
    } | null = null
    private automationService: { runNow(id: string): Promise<unknown> } | null = null
    private artifactService: { list(options: unknown): Promise<unknown> } | null = null

    constructor(
      _store: unknown,
      _stats: unknown,
      deps: { agentSessionClaimSigner: { keyId: string } }
    ) {
      signerKeyIds.push(deps.agentSessionClaimSigner.keyId)
    }

    prepareLegacyWorkerTerminalRecovery(): void {
      calls.push('prepare')
    }
    setAutomationService(service: NonNullable<Runtime['automationService']>): void {
      this.automationService = service
    }
    setArtifactService(service: NonNullable<Runtime['artifactService']>): void {
      this.artifactService = service
    }
    setCommitMessageAgentEnvironmentResolvers(): void {}
    setAccountServices(services: NonNullable<Runtime['accountServices']>): void {
      this.accountServices = services
    }
    getAccountsSnapshot(): unknown {
      if (!this.accountServices) {
        throw new Error('missing accounts')
      }
      return {
        claude: this.accountServices.claudeAccounts.listAccounts(),
        codex: this.accountServices.codexAccounts.listAccounts(),
        rateLimits: this.accountServices.rateLimits.getState()
      }
    }
    onAccountsChanged(): () => void {
      if (!this.accountServices) {
        throw new Error('missing accounts')
      }
      return () => {}
    }
    async runAutomationNow(id: string): Promise<unknown> {
      return this.automationService?.runNow(id)
    }
    async listArtifacts(options: unknown): Promise<unknown> {
      return this.artifactService?.list(options)
    }
    async refreshRestoredOrchestrationAuthority(): Promise<void> {
      calls.push('refresh')
    }
    async reconcileLegacyWorkerTerminals(): Promise<void> {
      calls.push('reconcile')
    }
  }

  class RateLimits {
    setCodexHomePathResolver(): void {}
    setClaudeAuthPreparationResolver(): void {}
    setCodexFetchTarget(): void {}
    setClaudeFetchTarget(): void {}
    setInactiveClaudeAccountsResolver(resolver: () => unknown): void {
      inactiveResolvers.claude = resolver
    }
    setInactiveCodexAccountsResolver(resolver: () => unknown): void {
      inactiveResolvers.codex = resolver
    }
    ingestLiveClaudeRateLimits(): void {}
    getState(): unknown {
      return { codex: null, claude: null }
    }
    start(): void {
      calls.push('rate-start')
    }
    stop(): void {
      calls.push('rate-stop')
      if (stopErrors.rateLimits) {
        throw stopErrors.rateLimits
      }
    }
  }

  class Automation {
    async runNow(id: string): Promise<unknown> {
      return { id }
    }
    start(): void {
      calls.push('automation-start')
    }
    stop(): void {
      calls.push('automation-stop')
    }
    async stopAndDrain(): Promise<void> {
      this.stop()
      if (stopErrors.automation) {
        throw stopErrors.automation
      }
    }
  }

  return {
    Automation,
    calls,
    inactiveResolvers,
    normalizationCalls,
    RateLimits,
    Runtime,
    signerKeyIds,
    stopErrors
  }
})

vi.mock('../main/runtime/orca-runtime', () => ({ OrcaRuntimeService: state.Runtime }))
vi.mock('../main/rate-limits/service', () => ({ RateLimitService: state.RateLimits }))
vi.mock('../main/automations/service', () => ({ AutomationService: state.Automation }))
vi.mock('../main/automations/headless-dispatch', () => ({
  createHeadlessAutomationOutputSnapshotBuffer: vi.fn()
}))
vi.mock('../main/automations/headless-workspace-create', () => ({
  buildHeadlessAutomationWorktreeCreateArgs: vi.fn()
}))
vi.mock('../main/artifacts/artifact-cloud-service', () => ({
  ArtifactCloudService: class {
    async list(options: unknown): Promise<unknown> {
      return { options }
    }
  }
}))
vi.mock('../main/codex-accounts/service', () => ({
  CodexAccountService: class {
    listAccounts(): unknown {
      return { accounts: [], activeAccountId: null }
    }
  }
}))
vi.mock('../main/claude-accounts/service', () => ({
  ClaudeAccountService: class {
    listAccounts(): unknown {
      return { accounts: [], activeAccountId: null }
    }
  }
}))
vi.mock('../main/codex-accounts/runtime-home-service', () => ({
  CodexRuntimeHomeService: class {
    prepareForRateLimitFetch(): null {
      return null
    }
    prepareForCodexLaunch(): null {
      return null
    }
    getHostCodexHomePathsForSessionDiscovery(): string[] {
      return []
    }
    isHostSystemDefaultRealHome(): boolean {
      return false
    }
    getSelectedHostAccountCodexHomePath(): null {
      return null
    }
  }
}))
vi.mock('../main/claude-accounts/runtime-auth-service', () => ({
  ClaudeRuntimeAuthService: class {
    async prepareForRateLimitFetch(): Promise<object> {
      return {}
    }
    async prepareForClaudeLaunch(): Promise<object> {
      return {}
    }
  }
}))
vi.mock('../main/rate-limits/codex-rate-limit-target', () => ({
  getInitialCodexRateLimitTarget: () => ({ runtime: 'host' })
}))
vi.mock('../main/rate-limits/claude-rate-limit-target', () => ({
  getInitialClaudeRateLimitTarget: () => ({ runtime: 'host' })
}))
vi.mock('../main/rate-limits/account-runtime-target-sync', () => ({
  createAccountRuntimeTargetSettingsSync: () => async () => {}
}))
vi.mock('../main/codex-accounts/runtime-selection', () => ({
  normalizeCodexRuntimeSelection: () => {
    state.normalizationCalls.codex += 1
    return { host: null, wsl: {} }
  }
}))
vi.mock('../main/claude-accounts/runtime-selection', () => ({
  normalizeClaudeRuntimeSelection: () => {
    state.normalizationCalls.claude += 1
    return { host: null, wsl: {} }
  }
}))

const hookServer = vi.hoisted(() => ({
  start: vi.fn(async () => state.calls.push('hook-start')),
  stop: vi.fn(() => state.calls.push('hook-stop-unjoined')),
  stopAndWait: vi.fn(async () => {
    state.calls.push('hook-stop-wait')
    if (state.stopErrors.hook) {
      throw state.stopErrors.hook
    }
  }),
  setClaudeStatusLineListener: vi.fn((listener: unknown) => {
    if (listener === null) {
      state.calls.push('hook-listener-clear')
    }
  }),
  ingestTerminalStatus: vi.fn(),
  getStatusSnapshot: vi.fn(() => []),
  getStatusSnapshotForPane: vi.fn(() => []),
  attestCompatibilityAuthority: vi.fn(() => null),
  retirePaneAuthority: vi.fn(),
  buildPtyEnv: vi.fn(() => ({}))
}))
vi.mock('../main/agent-hooks/server', () => ({ agentHookServer: hookServer }))
vi.mock('../main/agent-hooks/managed-agent-hook-controls', () => ({
  isAgentStatusHooksEnabled: () => true
}))
vi.mock('../main/daemon/daemon-init', () => ({ getDaemonProvider: () => ({}) }))
vi.mock('../main/ipc/pty', () => ({
  clearProviderPtyState: vi.fn(),
  getLocalPtyProvider: () => ({}),
  getSshPtyProvider: () => undefined,
  registerHeadlessPtyRuntime: () => state.calls.push('register-pty')
}))
vi.mock('../main/ipc/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: vi.fn()
}))

import { createBrowserlessRuntimeComposition } from './browserless-runtime-composition'

const temporaryPaths: string[] = []

afterEach(() => {
  state.calls.length = 0
  state.signerKeyIds.length = 0
  state.stopErrors.automation = null
  state.stopErrors.rateLimits = null
  state.stopErrors.targetSync = null
  state.stopErrors.hook = null
  state.inactiveResolvers.claude = null
  state.inactiveResolvers.codex = null
  state.normalizationCalls.claude = 0
  state.normalizationCalls.codex = 0
  vi.clearAllMocks()
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true })
  }
})

describe('browserless runtime composition', () => {
  it('provides browserless services and keeps authority stable across restarts', async () => {
    const dataPath = mkdtempSync(join(tmpdir(), 'orca-browserless-composition-'))
    temporaryPaths.push(dataPath)
    const store = createStore()

    const first = createBrowserlessRuntimeComposition({ store, dataPath })
    createBrowserlessRuntimeComposition({ store, dataPath })

    expect(first.runtime.getAccountsSnapshot()).toMatchObject({
      claude: { accounts: [] },
      codex: { accounts: [] },
      rateLimits: { codex: null, claude: null }
    })
    expect(() => first.runtime.onAccountsChanged(() => {})).not.toThrow()
    await expect(first.runtime.runAutomationNow('automation-1')).resolves.toEqual({
      id: 'automation-1'
    })
    await expect(first.runtime.listArtifacts({})).resolves.toEqual({ options: {} })
    expect(state.signerKeyIds).toHaveLength(2)
    expect(state.signerKeyIds[0]).toBe(state.signerKeyIds[1])
  })

  it('normalizes each account runtime selection once per inactive-account resolution', () => {
    const dataPath = mkdtempSync(join(tmpdir(), 'orca-browserless-composition-'))
    temporaryPaths.push(dataPath)
    createBrowserlessRuntimeComposition({ store: createStore(), dataPath })

    state.inactiveResolvers.claude?.()
    state.inactiveResolvers.codex?.()

    expect(state.normalizationCalls).toEqual({ claude: 1, codex: 1 })
  })

  it('orders startup recovery and joins owned lifecycle shutdown', async () => {
    const dataPath = mkdtempSync(join(tmpdir(), 'orca-browserless-composition-'))
    temporaryPaths.push(dataPath)
    const composition = createBrowserlessRuntimeComposition({ store: createStore(), dataPath })

    await composition.startAfterDaemon()
    await composition.stop()
    await composition.stop()

    expect(state.calls).toEqual([
      'prepare',
      'hook-start',
      'register-pty',
      'refresh',
      'reconcile',
      'rate-start',
      'automation-start',
      'automation-stop',
      'rate-stop',
      'target-sync-stop',
      'hook-listener-clear',
      'hook-stop-wait'
    ])
    expect(hookServer.stop).not.toHaveBeenCalled()
  })

  it('attempts every owned teardown in order and aggregates failures', async () => {
    const dataPath = mkdtempSync(join(tmpdir(), 'orca-browserless-composition-'))
    temporaryPaths.push(dataPath)
    const composition = createBrowserlessRuntimeComposition({ store: createStore(), dataPath })
    state.stopErrors.automation = new Error('automation drain failed')
    state.stopErrors.rateLimits = new Error('rate stop failed')
    state.stopErrors.targetSync = new Error('target sync stop failed')
    state.stopErrors.hook = new Error('hook stop failed')

    const error = await composition.stop().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([
      state.stopErrors.automation,
      state.stopErrors.rateLimits,
      state.stopErrors.targetSync,
      state.stopErrors.hook
    ])
    expect(state.calls).toEqual([
      'prepare',
      'automation-stop',
      'rate-stop',
      'target-sync-stop',
      'hook-listener-clear',
      'hook-stop-wait'
    ])
    await expect(composition.stop()).rejects.toBe(error)
    expect(hookServer.stop).not.toHaveBeenCalled()
  })

  it('cleans up once when startup fails', async () => {
    const dataPath = mkdtempSync(join(tmpdir(), 'orca-browserless-composition-'))
    temporaryPaths.push(dataPath)
    const composition = createBrowserlessRuntimeComposition({ store: createStore(), dataPath })
    hookServer.start.mockRejectedValueOnce(new Error('hook bind failed'))

    await expect(composition.startAfterDaemon()).rejects.toThrow('hook bind failed')
    await composition.stop()

    expect(state.calls).toEqual([
      'prepare',
      'automation-stop',
      'rate-stop',
      'target-sync-stop',
      'hook-listener-clear',
      'hook-stop-wait'
    ])
    await expect(composition.startAfterDaemon()).rejects.toThrow('already stopped')
  })
})

function createStore(): Store {
  const settings = { claudeManagedAccounts: [], codexManagedAccounts: [] }
  return {
    getSettings: () => settings,
    onSettingsChanged: () => () => {
      state.calls.push('target-sync-stop')
      if (state.stopErrors.targetSync) {
        throw state.stopErrors.targetSync
      }
    }
  } as unknown as Store
}
