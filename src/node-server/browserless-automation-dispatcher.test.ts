import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../main/runtime/orca-runtime'
import { createBrowserlessAutomationDispatcher } from './browserless-automation-dispatcher'

describe('browserless automation dispatcher', () => {
  it('cancels the terminal wait during server shutdown', async () => {
    const waitForTerminal = vi.fn(
      async (_handle: string, options: { signal?: AbortSignal }) =>
        await new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('request_aborted')), {
            once: true
          })
        })
    )
    const runtime = {
      launchAgentTerminal: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        tabId: 'tab-1',
        paneKey: 'pane-1',
        ptyId: 'pty-1',
        worktreeId: 'workspace-1'
      }),
      showManagedWorktree: vi.fn().mockResolvedValue({ displayName: 'Workspace' }),
      waitForTerminal,
      readTerminal: vi.fn()
    } as unknown as OrcaRuntimeService
    const controller = new AbortController()
    const dispatch = createBrowserlessAutomationDispatcher(runtime)

    const launch = await dispatch({
      automation: {
        workspaceMode: 'existing',
        workspaceId: 'workspace-1',
        agentId: 'claude',
        prompt: 'Run checks'
      },
      run: { title: 'Checks' },
      target: {},
      signal: controller.signal
    } as never)
    controller.abort()

    await expect(launch.completion).resolves.toEqual({
      status: 'dispatch_failed',
      outputSnapshot: null,
      error: 'Automation stopped during server shutdown.'
    })
    expect(runtime.readTerminal).not.toHaveBeenCalled()
  })

  it('bounds shutdown when existing-workspace terminal launch never settles', async () => {
    vi.useFakeTimers()
    try {
      let launchSignal: AbortSignal | undefined
      const runtime = {
        launchAgentTerminal: vi.fn(async (_selector: string, options: { signal?: AbortSignal }) => {
          launchSignal = options.signal
          return await new Promise<never>(() => undefined)
        }),
        showManagedWorktree: vi.fn(),
        waitForTerminal: vi.fn(),
        readTerminal: vi.fn()
      } as unknown as OrcaRuntimeService
      const controller = new AbortController()
      const dispatch = createBrowserlessAutomationDispatcher(runtime)
      const launched = dispatch({
        automation: {
          workspaceMode: 'existing',
          workspaceId: 'workspace-1',
          agentId: 'claude',
          prompt: 'Run checks'
        },
        run: { title: 'Checks' },
        target: {},
        signal: controller.signal
      } as never)
      expect(runtime.launchAgentTerminal).toHaveBeenCalledTimes(1)
      const rejection = expect(launched).rejects.toThrow(
        'Automation stopped during server shutdown.'
      )

      controller.abort()
      await vi.runAllTimersAsync()

      await rejection
      expect(launchSignal?.aborted).toBe(true)
      expect(runtime.showManagedWorktree).not.toHaveBeenCalled()
      expect(runtime.waitForTerminal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start workspace lookup after launch settles into an abort', async () => {
    const controller = new AbortController()
    const terminal = Promise.resolve({
      handle: 'terminal-1',
      worktreeId: 'workspace-1'
    })
    void terminal.then(() => controller.abort())
    const runtime = {
      launchAgentTerminal: vi.fn(() => terminal),
      showManagedWorktree: vi.fn(),
      waitForTerminal: vi.fn(),
      readTerminal: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatch = createBrowserlessAutomationDispatcher(runtime)

    await expect(
      dispatch({
        automation: {
          workspaceMode: 'existing',
          workspaceId: 'workspace-1',
          agentId: 'claude',
          prompt: 'Run checks'
        },
        run: { title: 'Checks' },
        target: {},
        signal: controller.signal
      } as never)
    ).rejects.toThrow('Automation stopped during server shutdown.')
    expect(runtime.showManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.waitForTerminal).not.toHaveBeenCalled()
  })

  it('joins an in-flight worktree creation before shutdown settles', async () => {
    let rejectCreate!: (error: Error) => void
    const create = new Promise<never>((_resolve, reject) => {
      rejectCreate = reject
    })
    const runtime = {
      createManagedWorktree: vi.fn(() => create),
      launchAgentTerminal: vi.fn(),
      showManagedWorktree: vi.fn(),
      waitForTerminal: vi.fn(),
      readTerminal: vi.fn()
    } as unknown as OrcaRuntimeService
    const controller = new AbortController()
    const dispatch = createBrowserlessAutomationDispatcher(runtime)
    let settled = false
    const launched = dispatch({
      automation: {
        workspaceMode: 'new_per_run',
        agentId: 'claude',
        prompt: 'Run checks'
      },
      run: { id: 'run-1', title: 'Checks', scheduledFor: Date.now() },
      target: { repo: { id: 'repo-1' } },
      signal: controller.signal
    } as never).finally(() => {
      settled = true
    })
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)

    controller.abort()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)

    rejectCreate(new Error('late create failure'))
    await expect(launched).rejects.toThrow('Automation stopped during server shutdown.')
    expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
    expect(runtime.waitForTerminal).not.toHaveBeenCalled()
  })

  it('bounds shutdown while resolving the launched workspace display', async () => {
    vi.useFakeTimers()
    try {
      const runtime = {
        launchAgentTerminal: vi.fn().mockResolvedValue({
          handle: 'terminal-1',
          worktreeId: 'workspace-1'
        }),
        showManagedWorktree: vi.fn(async () => await new Promise<never>(() => undefined)),
        waitForTerminal: vi.fn(),
        readTerminal: vi.fn()
      } as unknown as OrcaRuntimeService
      const controller = new AbortController()
      const dispatch = createBrowserlessAutomationDispatcher(runtime)
      const launched = dispatch({
        automation: {
          workspaceMode: 'existing',
          workspaceId: 'workspace-1',
          agentId: 'claude',
          prompt: 'Run checks'
        },
        run: { title: 'Checks' },
        target: {},
        signal: controller.signal
      } as never)
      await vi.advanceTimersByTimeAsync(0)
      expect(runtime.showManagedWorktree).toHaveBeenCalledTimes(1)
      const rejection = expect(launched).rejects.toThrow(
        'Automation stopped during server shutdown.'
      )

      controller.abort()
      await vi.runAllTimersAsync()

      await rejection
      expect(runtime.waitForTerminal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds shutdown while reading the completed terminal', async () => {
    vi.useFakeTimers()
    try {
      const runtime = {
        launchAgentTerminal: vi.fn().mockResolvedValue({
          handle: 'terminal-1',
          worktreeId: 'workspace-1'
        }),
        showManagedWorktree: vi.fn().mockResolvedValue({ displayName: 'Workspace' }),
        waitForTerminal: vi.fn().mockResolvedValue({ satisfied: true }),
        readTerminal: vi.fn(async () => await new Promise<never>(() => undefined))
      } as unknown as OrcaRuntimeService
      const controller = new AbortController()
      const dispatch = createBrowserlessAutomationDispatcher(runtime)
      const launch = await dispatch({
        automation: {
          workspaceMode: 'existing',
          workspaceId: 'workspace-1',
          agentId: 'claude',
          prompt: 'Run checks'
        },
        run: { title: 'Checks' },
        target: {},
        signal: controller.signal
      } as never)
      await vi.advanceTimersByTimeAsync(0)
      expect(runtime.readTerminal).toHaveBeenCalledTimes(1)
      const completion = expect(launch.completion).resolves.toEqual({
        status: 'dispatch_failed',
        outputSnapshot: null,
        error: 'Automation stopped during server shutdown.'
      })

      controller.abort()
      await vi.runAllTimersAsync()

      await completion
    } finally {
      vi.useRealTimers()
    }
  })
})
