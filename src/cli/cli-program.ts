import {
  findCommandSpec,
  isCommandGroup,
  normalizeCommandPositionals,
  parseArgs,
  resolveHelpPath,
  specPaths,
  validateCommandAndFlags
} from './args'
import { dispatch } from './dispatch'
import { reportCliError } from './format'
import { printHelp } from './help'
import type { RuntimeClient } from './runtime-client'
import { COMMAND_SPECS } from './specs'

export { COMMAND_SPECS } from './specs'
export { buildCurrentWorktreeSelector, normalizeWorktreeSelector } from './selectors'

const COMMAND_PATHS = COMMAND_SPECS.flatMap((spec) => specPaths(spec))

function shouldIgnoreRemoteSelection(commandPath: string[]): boolean {
  return (
    commandPath[0] === 'account' ||
    commandPath[0] === 'artifacts' ||
    commandPath[0] === 'environment' ||
    commandPath[0] === 'serve' ||
    commandPath[0] === 'agent' ||
    commandPath[0] === 'vm' ||
    commandPath[0] === 'agent-context'
  )
}

// Why: loading the runtime client after parsing keeps help and syntax errors lightweight.
async function loadRuntimeClientClass(): Promise<typeof RuntimeClient> {
  return (await import('./runtime-client.js')).RuntimeClient
}

// Why: SSH relay invocations carry the remote cwd because the host process cannot chdir there.
function resolveInvocationCwd(): string {
  const override = process.env.ORCA_CLI_CWD
  return typeof override === 'string' && override.length > 0 ? override : process.cwd()
}

export async function main(
  argv = process.argv.slice(2),
  cwd = resolveInvocationCwd()
): Promise<void> {
  if (argv[0] === 'agent-teams-tmux') {
    await runAgentTeamsTmuxShim(argv.slice(1))
    return
  }
  if (argv[0] === 'claude-teams') {
    await runClaudeTeams(argv.slice(1), cwd)
    return
  }
  const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, COMMAND_PATHS))
  const helpPath = resolveHelpPath(parsed)
  if (helpPath !== null) {
    printHelp(COMMAND_SPECS, helpPath)
    if (
      helpPath.length > 0 &&
      !findCommandSpec(COMMAND_SPECS, helpPath) &&
      !isCommandGroup(helpPath)
    ) {
      process.exitCode = 1
    }
    return
  }
  if (parsed.commandPath.length === 0) {
    printHelp(COMMAND_SPECS, [])
    return
  }
  const json = parsed.flags.has('json')

  try {
    // Why: syntax errors should not be masked by runtime lookup failures.
    validateCommandAndFlags(COMMAND_SPECS, parsed)
    const RuntimeClientClass = await loadRuntimeClientClass()
    const ignoreRemoteSelection = shouldIgnoreRemoteSelection(parsed.commandPath)
    const pairingCode = ignoreRemoteSelection ? null : parsed.flags.get('pairing-code')
    const environmentSelector = ignoreRemoteSelection ? null : parsed.flags.get('environment')
    // Why: null prevents environment fallbacks from reactivating remote selection for local commands.
    let client: RuntimeClient | undefined
    await dispatch(parsed.commandPath, {
      flags: parsed.flags,
      get client() {
        client ??= new RuntimeClientClass(
          undefined,
          undefined,
          typeof pairingCode === 'string' ? pairingCode : ignoreRemoteSelection ? null : undefined,
          typeof environmentSelector === 'string'
            ? environmentSelector
            : ignoreRemoteSelection
              ? null
              : undefined
        )
        return client
      },
      cwd,
      json
    })
  } catch (error) {
    reportCliError(error, json, { commandPath: parsed.commandPath })
    process.exitCode = 1
  }
}

async function runClaudeTeams(argv: string[], cwd: string): Promise<void> {
  try {
    // Why: Claude owns every argument following the compatibility command.
    const client = new (await loadRuntimeClientClass())(undefined, undefined, null, null)
    await dispatch(['claude-teams'], {
      flags: new Map(),
      client,
      cwd,
      json: false,
      rawArgs: argv
    })
  } catch (error) {
    reportCliError(error, false, { commandPath: ['claude-teams'] })
    process.exitCode = 1
  }
}

async function runAgentTeamsTmuxShim(argv: string[]): Promise<void> {
  try {
    const client = new (await loadRuntimeClientClass())(undefined, 10_000)
    const response = await client.call<{
      tmux: { stdout: string; stderr: string; exitCode: number }
    }>(
      'agentTeams.tmuxCompat',
      {
        teamId: process.env.ORCA_AGENT_TEAMS_TEAM_ID,
        token: process.env.ORCA_AGENT_TEAMS_TOKEN,
        envPane: process.env.TMUX_PANE,
        cwd: process.cwd(),
        argv
      },
      { timeoutMs: 10_000 }
    )
    process.stdout.write(response.result.tmux.stdout)
    process.stderr.write(response.result.tmux.stderr)
    process.exitCode = response.result.tmux.exitCode
  } catch (error) {
    reportCliError(error, false, { commandPath: ['agent-teams-tmux'] })
    process.exitCode = 1
  }
}
