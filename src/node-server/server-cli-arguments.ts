export type ServerCliArguments = {
  command: 'serve' | 'help' | 'version'
  dataPath?: string
  json: boolean
  listenHost?: string
  noPairing: boolean
  pairingAddress?: string
  port: number
}

export function parseServerCliArguments(argv: string[]): ServerCliArguments {
  const args = argv[0] === 'serve' ? argv.slice(1) : argv
  if (args.includes('--help') || args.includes('-h') || argv[0] === 'help') {
    return defaults('help')
  }
  if (args.includes('--version') || args.includes('-v') || argv[0] === 'version') {
    return defaults('version')
  }
  const parsed = defaults('serve')
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      parsed.json = true
    } else if (arg === '--no-pairing') {
      parsed.noPairing = true
    } else if (arg === '--listen') {
      parsed.listenHost = readValue(args, ++index, arg)
    } else if (arg === '--port') {
      parsed.port = parsePort(readValue(args, ++index, arg))
    } else if (arg === '--pairing-address') {
      parsed.pairingAddress = readValue(args, ++index, arg)
    } else if (arg === '--data-dir') {
      parsed.dataPath = readValue(args, ++index, arg)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return parsed
}

function defaults(command: ServerCliArguments['command']): ServerCliArguments {
  return { command, json: false, noPairing: false, port: 6768 }
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid --port value: ${value}`)
  }
  return port
}

export function renderServerHelp(): string {
  return `Usage: orca-ide [serve] [options]

Start a browserless Orca host for remote desktop and web clients.

Options:
  --port <port>                 WebSocket/HTTP port (default: 6768; 0 = random)
  --listen <host>               Listener interface (default: Tailscale or loopback)
  --pairing-address <address>  Reachable host or ws(s) URL embedded in access links
  --data-dir <path>            Persistent server state directory
  --no-pairing                 Start without printing a new access link
  --json                       Print versioned machine-readable readiness
  -h, --help                   Show help
  -v, --version                Show version`
}
