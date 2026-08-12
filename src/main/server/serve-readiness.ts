import type { PairingOfferUnavailableReason } from '../runtime/runtime-rpc'

export type ServePairingUnavailableReason = PairingOfferUnavailableReason | 'disabled_by_operator'

export type ServePairingReadiness =
  | {
      available: true
      url: string
      endpoint: string
      deviceId: string
      webClientUrl: string | null
      scope: 'runtime' | 'mobile'
      qr: string | null
    }
  | {
      available: false
      reason: ServePairingUnavailableReason
      guidance: string
    }

export type ServeReadiness = {
  runtimeId: string
  boundEndpoint: string | null
  advertisedEndpoint: string | null
  managedWslCliReconciliation: 'pending' | 'settled' | 'failed'
  pairing: ServePairingReadiness
}

export type ServeReadinessOutput =
  | { mode: 'human' | 'json' }
  | { mode: 'recipe-json'; projectRoot: string }

type ReadinessWrite = (output: string) => Promise<void>

type HumanReadinessPresentation = {
  hyperlinks: boolean
}

const plainHumanPresentation: HumanReadinessPresentation = { hyperlinks: false }

export class ServeReadinessPublisher {
  private state: 'pending' | 'publishing' | 'published' | 'failed' = 'pending'

  constructor(
    private readonly write: ReadinessWrite = writeStdout,
    private readonly presentation: HumanReadinessPresentation = write === writeStdout
      ? detectHumanPresentation()
      : plainHumanPresentation
  ) {}

  async publish(
    readiness: ServeReadiness,
    output: ServeReadinessOutput,
    signal?: AbortSignal
  ): Promise<void> {
    if (this.state !== 'pending') {
      throw new Error(`Serve readiness publication already ${this.state}`)
    }
    signal?.throwIfAborted()
    this.state = 'publishing'
    try {
      await this.write(`${renderServeReadiness(readiness, output, this.presentation)}\n`)
      this.state = 'published'
    } catch (error) {
      this.state = 'failed'
      throw error
    }
  }
}

export function renderServeReadiness(
  readiness: ServeReadiness,
  output: ServeReadinessOutput,
  presentation: HumanReadinessPresentation = plainHumanPresentation
): string {
  if (output.mode === 'recipe-json') {
    if (!readiness.pairing.available) {
      throw new Error(
        `Recipe JSON output requires runtime pairing: ${readiness.pairing.reason}. ${readiness.pairing.guidance}`
      )
    }
    return JSON.stringify({
      schemaVersion: 1,
      pairingCode: readiness.pairing.url,
      projectRoot: output.projectRoot
    })
  }
  if (output.mode === 'json') {
    return JSON.stringify({
      type: 'orca_server_ready',
      schemaVersion: 1,
      runtimeId: readiness.runtimeId,
      endpoint: readiness.boundEndpoint,
      boundEndpoint: readiness.boundEndpoint,
      advertisedEndpoint: readiness.advertisedEndpoint,
      managedWslCliReconciliation: readiness.managedWslCliReconciliation,
      pairing: readiness.pairing
    })
  }
  return renderHumanReadiness(readiness, presentation)
}

function renderHumanReadiness(
  readiness: ServeReadiness,
  presentation: HumanReadinessPresentation
): string {
  if (!presentation.hyperlinks) {
    return renderPlainHumanReadiness(readiness)
  }

  const lines = ['Orca server is ready', '']
  if (readiness.pairing.available) {
    lines.push('Connect  (click for options, or Cmd/Ctrl-click)')
    if (readiness.pairing.webClientUrl) {
      lines.push(
        `  Web browser   ${terminalHyperlink('Open web client', readiness.pairing.webClientUrl)}`
      )
    }
    if (readiness.pairing.scope === 'mobile' && readiness.pairing.qr) {
      lines.push('', `Mobile pairing QR:\n${readiness.pairing.qr}`)
    }
    lines.push(`  Desktop app  ${terminalHyperlink('Add this host', readiness.pairing.url)}`)
    lines.push('', '  These links contain access credentials. Keep them private.')
  } else {
    lines.push(
      'Pairing is unavailable',
      `  Reason  ${readiness.pairing.reason}`,
      `  Fix     ${readiness.pairing.guidance}`
    )
  }
  lines.push(
    '',
    'Server details',
    `  Listening on  ${readiness.boundEndpoint ?? 'websocket unavailable'}`,
    `  Pairing uses  ${readiness.advertisedEndpoint ?? 'unavailable'}`,
    '',
    'Keep this terminal open. Press Ctrl+C to stop.'
  )
  return lines.join('\n')
}

function renderPlainHumanReadiness(readiness: ServeReadiness): string {
  const lines = ['Orca server is ready', '']
  if (readiness.pairing.available) {
    if (readiness.pairing.webClientUrl) {
      lines.push('Open the web client:', `Web client URL: ${readiness.pairing.webClientUrl}`, '')
    }
    if (readiness.pairing.scope === 'mobile' && readiness.pairing.qr) {
      lines.push(`Mobile pairing QR:\n${readiness.pairing.qr}`, '')
    }
    lines.push('Or connect from the desktop app:', `Pairing URL: ${readiness.pairing.url}`, '')
  } else {
    lines.push(
      `Pairing unavailable: ${readiness.pairing.reason}`,
      `Pairing guidance: ${readiness.pairing.guidance}`,
      ''
    )
  }
  lines.push(
    'Server details:',
    `Bound endpoint: ${readiness.boundEndpoint ?? 'websocket unavailable'}`,
    `Advertised endpoint: ${readiness.advertisedEndpoint ?? 'unavailable'}`,
    '',
    'Keep this terminal open. Press Ctrl+C to stop.'
  )
  return lines.join('\n')
}

function terminalHyperlink(label: string, destination: string): string {
  return `\u001B]8;;${destination}\u001B\\${label}\u001B]8;;\u001B\\`
}

function detectHumanPresentation(): HumanReadinessPresentation {
  return {
    hyperlinks:
      process.stdout.isTTY === true &&
      process.env.FORCE_HYPERLINK !== '0' &&
      process.env.TERM !== 'dumb'
  }
}

function writeStdout(output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(output, (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}
