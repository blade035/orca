import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../main/persistence'

const state = vi.hoisted(() => {
  const calls: string[] = []
  const signerKeyIds: string[] = []

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
    setInactiveClaudeAccountsResolver(): void {}
    setInactiveCodexAccountsResolver(): void {}
    ingestLiveClaudeRateLimits(): void {}
    getState(): unknown {
      return { codex: null, claude: null }
    }
    start(): void {
      calls.push('rate-start')
    }
    stop(): void {
      calls.push('rate-stop')
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
    }
  }

  return { Automation, calls, RateLimits, Runtime, signerKeyIds }
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
  normalizeCodexRuntimeSelection: () => ({ host: null, wsl: {} })
}))
vi.mock('../main/claude-accounts/runtime-selection', () => ({
  normalizeClaudeRuntimeSelection: () => ({ host: null, wsl: {} })
}))

const hookServer = vi.hoisted(() => ({
  start: vi.fn(async () => state.calls.push('hook-start')),
  stop: vi.fn(() => state.calls.push('hook-stop')),
  stopAndWait: vi.fn(async () => state.calls.push('hook-stop')),
  setClaudeStatusLineListener: vi.fn(),
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
      'hook-stop'
    ])
  })

  it('cleans up once when startup fails', async () => {
    const dataPath = mkdtempSync(join(tmpdir(), 'orca-browserless-composition-'))
    temporaryPaths.push(dataPath)
    const composition = createBrowserlessRuntimeComposition({ store: createStore(), dataPath })
    hookServer.start.mockRejectedValueOnce(new Error('hook bind failed'))

    await expect(composition.startAfterDaemon()).rejects.toThrow('hook bind failed')
    await composition.stop()

    expect(state.calls).toEqual(['prepare', 'automation-stop', 'rate-stop', 'hook-stop'])
    await expect(composition.startAfterDaemon()).rejects.toThrow('already stopped')
  })
})

function createStore(): Store {
  const settings = { claudeManagedAccounts: [], codexManagedAccounts: [] }
  return {
    getSettings: () => settings,
    onSettingsChanged: () => () => {}
  } as unknown as Store
}
