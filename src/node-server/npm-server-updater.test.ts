import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNpmServerUpdater, reportNpmSupervisorActivationSuccess } from './npm-server-updater'

const mocks = vi.hoisted(() => ({
  activate: vi.fn((_message?: unknown, _onDeliveryError?: () => void) => true),
  ensurePinned: vi.fn(async () => '/runtime/cli.js'),
  verifyPinned: vi.fn<() => Promise<string | null>>(async () => null),
  readState: vi.fn(async () => ({ schemaVersion: 1 })),
  runNpm: vi.fn(async () => ({ code: 0, stdout: '"1.4.179"', stderr: '' })),
  writeState: vi.fn(async () => undefined)
}))

vi.mock('./npm-pinned-runtime', () => ({
  ensurePinnedNpmRuntime: mocks.ensurePinned,
  verifyPinnedNpmRuntime: mocks.verifyPinned
}))
vi.mock('./npm-process-runner', () => ({ runNpmCommand: mocks.runNpm }))
vi.mock('./npm-supervisor-protocol', () => ({
  NPM_SUPERVISOR_PROTOCOL_VERSION: 1,
  isExactNpmVersion: (value: string) => /^\d+\.\d+\.\d+(?:-[\dA-Za-z.-]+)?$/.test(value),
  requestNpmSupervisorActivation: mocks.activate
}))
vi.mock('./npm-supervisor-state', () => ({
  readNpmSupervisorState: mocks.readState,
  writeNpmSupervisorState: mocks.writeState
}))

describe('npm server updater', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.activate.mockReturnValue(true)
    mocks.verifyPinned.mockResolvedValue(null)
    mocks.runNpm.mockResolvedValue({ code: 0, stdout: '"1.4.179"', stderr: '' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves an exact target, stages it, and requests supervised activation', async () => {
    const updater = createNpmServerUpdater({ dataPath: '/profile' })

    expect(updater.check('runtime-old', { targetVersion: '1.4.179' }).status.state).toBe('checking')
    await vi.waitFor(() =>
      expect(updater.getSnapshot('runtime-old').status.state).toBe('available')
    )
    expect(mocks.runNpm).toHaveBeenCalledWith(
      ['view', '@stablyai/orca@1.4.179', 'version', '--json'],
      60_000,
      undefined
    )

    expect(updater.download('runtime-old').status.state).toBe('downloading')
    await vi.waitFor(() =>
      expect(updater.getSnapshot('runtime-old').status.state).toBe('downloaded')
    )
    const result = updater.install('runtime-old', ['updater.safe-install-ack.v1'], 'device-a')
    const duplicate = updater.install('runtime-old', ['updater.safe-install-ack.v1'], 'device-a')

    expect(result).toMatchObject({
      accepted: true,
      targetVersion: '1.4.179',
      runtimeId: 'runtime-old'
    })
    expect(duplicate).toBe(result)
    expect(mocks.activate).not.toHaveBeenCalled()
    updater.getSnapshot('runtime-old', {
      acknowledgementId: '00000000-0000-4000-8000-000000000000',
      requesterId: 'device-a'
    })
    expect(mocks.activate).not.toHaveBeenCalled()
    updater.getSnapshot('runtime-old', {
      acknowledgementId: result.acknowledgementId,
      requesterId: 'device-a'
    })
    expect(mocks.activate).toHaveBeenCalledOnce()
    expect(mocks.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca:npm-update-activate',
        targetVersion: '1.4.179',
        runtimeId: 'runtime-old'
      }),
      expect.any(Function)
    )
  })

  it('reuses an already pinned exact target without querying the registry', async () => {
    mocks.verifyPinned.mockResolvedValue('/runtime/cli.js')
    const updater = createNpmServerUpdater({ dataPath: '/profile' })

    updater.check('runtime-old', { targetVersion: '1.4.179' })

    await vi.waitFor(() =>
      expect(updater.getSnapshot('runtime-old').status.state).toBe('available')
    )
    expect(mocks.runNpm).not.toHaveBeenCalled()
  })

  it('rejects non-exact targets without invoking npm', async () => {
    const updater = createNpmServerUpdater({ dataPath: '/profile' })

    updater.check('runtime-old', { targetVersion: 'latest' })

    await vi.waitFor(() => expect(updater.getSnapshot('runtime-old').status.state).toBe('error'))
    expect(mocks.runNpm).not.toHaveBeenCalled()
  })

  it('does not activate when candidate staging or preflight fails', async () => {
    mocks.ensurePinned.mockRejectedValueOnce(new Error('npm_update_preflight_invalid'))
    const updater = createNpmServerUpdater({ dataPath: '/profile' })
    updater.check('runtime-old', { targetVersion: '1.4.179' })
    await vi.waitFor(() =>
      expect(updater.getSnapshot('runtime-old').status.state).toBe('available')
    )

    updater.download('runtime-old')

    await vi.waitFor(() => expect(updater.getSnapshot('runtime-old').status.state).toBe('error'))
    expect(() => updater.install('runtime-old')).toThrow('remote_update_not_downloaded')
    expect(mocks.activate).not.toHaveBeenCalled()
  })

  it('rejects install from a client without safe acknowledgement support', async () => {
    const updater = createNpmServerUpdater({ dataPath: '/profile' })
    updater.check('runtime-old', { targetVersion: '1.4.179' })
    await vi.waitFor(() =>
      expect(updater.getSnapshot('runtime-old').status.state).toBe('available')
    )
    updater.download('runtime-old')
    await vi.waitFor(() =>
      expect(updater.getSnapshot('runtime-old').status.state).toBe('downloaded')
    )

    expect(() => updater.install('runtime-old')).toThrow('remote_update_client_upgrade_required')
    expect(() => updater.install('runtime-old', ['updater.safe-install-ack.v1'])).toThrow(
      'remote_update_client_identity_required'
    )
    expect(mocks.activate).not.toHaveBeenCalled()
  })

  it('publishes a rollback failure under the originating runtime identity', () => {
    const updater = createNpmServerUpdater({
      dataPath: '/profile',
      initialFailure: {
        requestId: 'request-1',
        fromVersion: '1.4.0',
        targetVersion: '1.5.0',
        originRuntimeId: 'runtime-old',
        reason: 'npm_update_worker_ready_timeout'
      }
    })

    expect(updater.getSnapshot('runtime-rollback')).toMatchObject({
      runtimeId: 'runtime-old',
      status: { state: 'error', message: 'npm_update_worker_ready_timeout' }
    })
  })

  it('does not claim activation when the supervisor channel is gone', async () => {
    mocks.activate.mockReturnValue(false)
    const updater = createNpmServerUpdater({ dataPath: '/profile' })
    updater.check('runtime-old', { targetVersion: '1.4.179' })
    await vi.waitFor(() =>
      expect(updater.getSnapshot('runtime-old').status.state).toBe('available')
    )
    updater.download('runtime-old')
    await vi.waitFor(() =>
      expect(updater.getSnapshot('runtime-old').status.state).toBe('downloaded')
    )

    const install = updater.install('runtime-old', ['updater.safe-install-ack.v1'], 'device-a')
    expect(install).toMatchObject({ accepted: true })
    expect(
      updater.getSnapshot('runtime-old', {
        acknowledgementId: install.acknowledgementId,
        requesterId: 'device-a'
      }).status
    ).toMatchObject({
      state: 'error',
      message: 'npm_update_supervisor_unavailable'
    })
  })

  it('keeps one receipt armed across unrelated client requests', async () => {
    const updater = await createDownloadedUpdater()
    vi.useFakeTimers()
    const install = updater.install('runtime-old', ['updater.safe-install-ack.v1'], 'device-a')

    expect(() => updater.check('runtime-other')).toThrow('remote_update_activation_pending')
    updater.getSnapshot('runtime-other', {
      acknowledgementId: '00000000-0000-4000-8000-000000000000',
      requesterId: 'device-b'
    })
    expect(mocks.activate).not.toHaveBeenCalled()

    updater.getSnapshot('runtime-old', {
      acknowledgementId: install.acknowledgementId,
      requesterId: 'device-a'
    })
    updater.getSnapshot('runtime-old', {
      acknowledgementId: install.acknowledgementId,
      requesterId: 'device-a'
    })
    expect(mocks.activate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns a lost install receipt only to its paired device', async () => {
    const updater = await createDownloadedUpdater()
    const install = updater.install('runtime-old', ['updater.safe-install-ack.v1'], 'device-a')

    expect(() =>
      updater.install('runtime-old', ['updater.safe-install-ack.v1'], 'device-b')
    ).toThrow('remote_update_activation_pending')
    expect(() => updater.download('runtime-other')).toThrow('remote_update_activation_pending')
    updater.getSnapshot('runtime-other', {
      acknowledgementId: install.acknowledgementId,
      requesterId: 'device-b'
    })
    expect(mocks.activate).not.toHaveBeenCalled()

    expect(updater.install('runtime-old', ['updater.safe-install-ack.v1'], 'device-a')).toBe(
      install
    )
    updater.getSnapshot('runtime-old', {
      acknowledgementId: install.acknowledgementId,
      requesterId: 'device-a'
    })
    expect(mocks.activate).toHaveBeenCalledOnce()
  })

  it('expires an abandoned receipt without activating it', async () => {
    const updater = await createDownloadedUpdater()
    vi.useFakeTimers()
    updater.install('runtime-old', ['updater.safe-install-ack.v1'], 'device-a')

    await vi.advanceTimersByTimeAsync(2 * 60_000)

    expect(updater.getSnapshot('runtime-old').status).toMatchObject({
      state: 'error',
      message: 'npm_update_acknowledgement_timeout'
    })
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('surfaces asynchronous supervisor delivery failure', async () => {
    mocks.activate.mockImplementationOnce((_message, onDeliveryError) => {
      onDeliveryError?.()
      return true
    })
    const updater = await createDownloadedUpdater()
    const install = updater.install('runtime-old', ['updater.safe-install-ack.v1'], 'device-a')

    updater.getSnapshot('runtime-old', {
      acknowledgementId: install.acknowledgementId,
      requesterId: 'device-a'
    })

    expect(updater.getSnapshot('runtime-old').status).toMatchObject({
      state: 'error',
      message: 'npm_update_supervisor_unavailable'
    })
  })

  it('publishes only the matching committed receipt', async () => {
    const updater = await createDownloadedUpdater()
    const install = updater.install('runtime-old', ['updater.safe-install-ack.v1'], 'device-a')
    updater.getSnapshot('runtime-old', {
      acknowledgementId: install.acknowledgementId,
      requesterId: 'device-a'
    })

    reportNpmSupervisorActivationSuccess({
      type: 'orca:npm-update-committed',
      protocolVersion: 1,
      requestId: install.acknowledgementId!
    })

    expect(updater.getSnapshot('runtime-new').completedAcknowledgementId).toBe(
      install.acknowledgementId
    )
  })
})

async function createDownloadedUpdater() {
  const updater = createNpmServerUpdater({ dataPath: '/profile' })
  updater.check('runtime-old', { targetVersion: '1.4.179' })
  await vi.waitFor(() => expect(updater.getSnapshot('runtime-old').status.state).toBe('available'))
  updater.download('runtime-old')
  await vi.waitFor(() => expect(updater.getSnapshot('runtime-old').status.state).toBe('downloaded'))
  return updater
}
