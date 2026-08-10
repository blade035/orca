import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertInstalledCliSuccess,
  assertSingleInstalledReadiness,
  formatInstalledExit,
  installedReadinessEvents,
  installedServeArguments,
  runInstalledCli,
  runInstalledCliJson,
  startInstalledServer,
  stopInstalledServer,
  terminateInstalledServer,
  waitForInstalledServerExit,
  type RunningInstalledServer
} from './node-server-installed-process-harness'
import { stopNodeServerVerifierDaemons } from './node-server-verifier-daemon-cleanup'

type RpcJson<TResult> = {
  ok: true
  result: TResult
  _meta: { runtimeId: string }
}

export async function verifyInstalledCliProfileBehavior(options: {
  cliPath: string
  dataPath: string
  expectedRuntimeId: string
  expectedVersion: string
  pairingUrl: string
  terminalHandle: string
  temporaryRoot: string
}): Promise<void> {
  await verifyLiveOwnerRefusal(options)
  await verifyInstalledCommandSurface(options)
  await verifyControlCliRoutes(options)
  await verifyIndependentProfileLifecycle(options)
  if (process.platform !== 'win32') {
    await verifyCrashRecovery(options)
  }
  process.stdout.write('Installed CLI profile oracle passed\n')
}

async function verifyInstalledCommandSurface(options: {
  cliPath: string
  dataPath: string
  expectedVersion: string
}): Promise<void> {
  const controlHelp = await runInstalledCli(options.cliPath, options.dataPath, ['--help'])
  assertInstalledCliSuccess(controlHelp, '--help')
  assert(controlHelp.stdout.includes('Usage: orca <command> [options]'), '--help omitted CLI help')
  assert(installedReadinessEvents(controlHelp.stdout) === 0, '--help emitted server readiness')

  const serverHelp = await runInstalledCli(options.cliPath, options.dataPath, ['serve', '--help'])
  assertInstalledCliSuccess(serverHelp, 'serve --help')
  assert(
    serverHelp.stdout.includes('Start a browserless Orca host'),
    'serve --help omitted server help'
  )
  assert(installedReadinessEvents(serverHelp.stdout) === 0, 'serve --help emitted readiness')

  const version = await runInstalledCli(options.cliPath, options.dataPath, ['--version'])
  assertInstalledCliSuccess(version, '--version')
  assert(version.stdout.trim() === options.expectedVersion, '--version did not match the package')
  assert(installedReadinessEvents(version.stdout) === 0, '--version emitted server readiness')
}

async function verifyControlCliRoutes(options: {
  cliPath: string
  dataPath: string
  expectedRuntimeId: string
  expectedVersion: string
  pairingUrl: string
  terminalHandle: string
}): Promise<void> {
  const status = await runInstalledCliJson<
    RpcJson<{ runtime: { runtimeId: string | null; appVersion?: string } }>
  >(options, ['status', '--json'])
  assert(status._meta.runtimeId === options.expectedRuntimeId, 'status used the wrong profile')
  assert(
    status.result.runtime.runtimeId === options.expectedRuntimeId,
    'status used the wrong runtime'
  )
  assert(
    status.result.runtime.appVersion === options.expectedVersion,
    'status used the wrong version'
  )

  const terminals = await runInstalledCliJson<RpcJson<{ terminals: { handle: string }[] }>>(
    options,
    ['terminal', 'list', '--json']
  )
  assert(
    terminals._meta.runtimeId === options.expectedRuntimeId,
    'terminal list used the wrong profile'
  )
  assert(
    terminals.result.terminals.some((terminal) => terminal.handle === options.terminalHandle),
    'terminal list omitted the npm profile terminal'
  )

  const runs = await runInstalledCliJson<RpcJson<{ runs: unknown[] }>>(options, [
    'orchestration',
    'run-list',
    '--json'
  ])
  assert(runs._meta.runtimeId === options.expectedRuntimeId, 'orchestration used the wrong profile')
  assert(Array.isArray(runs.result.runs), 'orchestration read returned invalid JSON')

  const accounts = await runInstalledCliJson<
    RpcJson<{ claude: { accounts: unknown[] }; codex: { accounts: unknown[] } }>
  >(options, ['account', 'list', '--json'])
  assert(
    accounts._meta.runtimeId === options.expectedRuntimeId,
    'account list used the wrong profile'
  )
  assert(
    Array.isArray(accounts.result.claude.accounts) && Array.isArray(accounts.result.codex.accounts),
    'account list returned invalid JSON'
  )

  await runInstalledCliJson(options, [
    'environment',
    'add',
    '--name',
    'installed-profile-oracle',
    '--pairing-code',
    options.pairingUrl,
    '--json'
  ])
  const environments = await runInstalledCliJson<{
    result: { environments: { name: string }[] }
    _meta: { runtimeId: string }
  }>(options, ['environment', 'list', '--json'])
  assert(
    environments._meta.runtimeId === 'local',
    'environment list did not use local profile state'
  )
  assert(
    environments.result.environments.some(
      (environment) => environment.name === 'installed-profile-oracle'
    ),
    'environment list did not use the npm profile data directory'
  )

  const skill = await runInstalledCli(options.cliPath, options.dataPath, [
    'skills',
    'get',
    'orchestration',
    '--full'
  ])
  assertInstalledCliSuccess(skill, 'skills get')
  assert(
    skill.stdout.includes('# Orca Inter-Agent Orchestration'),
    'skills get did not return the installed full guide'
  )
  assert(installedReadinessEvents(skill.stdout) === 0, 'control command emitted server readiness')
}

async function verifyLiveOwnerRefusal(options: {
  cliPath: string
  dataPath: string
  expectedRuntimeId: string
}): Promise<void> {
  const before = snapshotProfileState(options.dataPath)
  const duplicate = await runInstalledCli(
    options.cliPath,
    options.dataPath,
    installedServeArguments()
  )
  assert(duplicate.code === 3, `duplicate server exited ${formatInstalledExit(duplicate)}`)
  assert(installedReadinessEvents(duplicate.stdout) === 0, 'duplicate server emitted readiness')
  assertProfileStateUnchanged(options.dataPath, before)

  const status = await runInstalledCliJson<RpcJson<{ runtime: { runtimeId: string | null } }>>(
    options,
    ['status', '--json']
  )
  assert(
    status.result.runtime.runtimeId === options.expectedRuntimeId,
    'live owner stopped responding'
  )
}

async function verifyIndependentProfileLifecycle(options: {
  cliPath: string
  expectedRuntimeId: string
  temporaryRoot: string
}): Promise<void> {
  const dataPath = join(options.temporaryRoot, 'independent-profile')
  let server: RunningInstalledServer | null = null
  try {
    server = await startInstalledServer(options.cliPath, dataPath, [])
    const status = await runInstalledCliJson<RpcJson<{ runtime: { runtimeId: string | null } }>>(
      { cliPath: options.cliPath, dataPath },
      ['status', '--json']
    )
    assert(
      status.result.runtime.runtimeId !== options.expectedRuntimeId,
      'profiles shared a runtime'
    )
    await stopInstalledServer(server)
    assertSingleInstalledReadiness(server, 'zero-argument server')
    assertStoppedProfileLockState(dataPath)
    server = null

    server = await startInstalledServer(options.cliPath, dataPath, installedServeArguments())
    await runInstalledCliJson({ cliPath: options.cliPath, dataPath }, ['status', '--json'])
    await stopInstalledServer(server)
    assertSingleInstalledReadiness(server, 'serve command')
    assertStoppedProfileLockState(dataPath)
    server = null
  } finally {
    await terminateInstalledServer(server)
    await stopNodeServerVerifierDaemons(dataPath)
  }
}

async function verifyCrashRecovery(options: {
  cliPath: string
  temporaryRoot: string
}): Promise<void> {
  const dataPath = join(options.temporaryRoot, 'crash-profile')
  let server: RunningInstalledServer | null = null
  try {
    server = await startInstalledServer(options.cliPath, dataPath, installedServeArguments())
    server.child.kill('SIGKILL')
    await waitForInstalledServerExit(server.child)
    assertSingleInstalledReadiness(server, 'crashed server')
    server = null

    server = await startInstalledServer(options.cliPath, dataPath, installedServeArguments())
    await runInstalledCliJson({ cliPath: options.cliPath, dataPath }, ['status', '--json'])
    await stopInstalledServer(server)
    assertSingleInstalledReadiness(server, 'crash replacement')
    server = null
  } finally {
    await terminateInstalledServer(server)
    await stopNodeServerVerifierDaemons(dataPath)
  }
}

function snapshotProfileState(dataPath: string): Map<string, Buffer | null> {
  return new Map(
    ['orca-runtime.json', join('.server-profile-process-lock', 'managed-hook-install.lock')].map(
      (name) => {
        const path = join(dataPath, name)
        return [name, existsSync(path) ? readFileSync(path) : null]
      }
    )
  )
}

function assertStoppedProfileLockState(dataPath: string): void {
  const lockPath = join(dataPath, '.server-profile-process-lock', 'managed-hook-install.lock')
  assert(
    existsSync(lockPath) === (process.platform === 'win32'),
    process.platform === 'win32'
      ? 'Windows forced termination unexpectedly released the profile lock'
      : 'graceful server shutdown retained the profile lock'
  )
}

function assertProfileStateUnchanged(dataPath: string, before: Map<string, Buffer | null>): void {
  const after = snapshotProfileState(dataPath)
  for (const [name, prior] of before) {
    const current = after.get(name) ?? null
    assert(
      prior === null ? current === null : current !== null && prior.equals(current),
      `duplicate server mutated ${name}`
    )
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}
