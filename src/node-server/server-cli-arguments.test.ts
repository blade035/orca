import { describe, expect, it } from 'vitest'
import { parseServerCliArguments, renderServerHelp } from './server-cli-arguments'

describe('parseServerCliArguments', () => {
  it('starts the server with safe defaults when no command is supplied', () => {
    expect(parseServerCliArguments([])).toEqual({
      command: 'serve',
      json: false,
      noPairing: false,
      port: 6768
    })
  })

  it('parses the automation controls after an optional serve command', () => {
    expect(
      parseServerCliArguments([
        'serve',
        '--port',
        '0',
        '--listen',
        '100.64.1.20',
        '--pairing-address',
        'vpn.example.test:7443',
        '--data-dir',
        './state',
        '--no-pairing',
        '--json'
      ])
    ).toEqual({
      command: 'serve',
      dataPath: './state',
      json: true,
      listenHost: '100.64.1.20',
      noPairing: true,
      pairingAddress: 'vpn.example.test:7443',
      port: 0
    })
  })

  it.each([
    [['--port'], '--port requires a value'],
    [['--port', '-1'], 'Invalid --port value: -1'],
    [['--port', '65536'], 'Invalid --port value: 65536'],
    [['--listen'], '--listen requires a value'],
    [['--unknown'], 'Unknown argument: --unknown']
  ])('rejects invalid input %j', (args, message) => {
    expect(() => parseServerCliArguments(args)).toThrow(message)
  })

  it('documents the durable executable and all supported controls', () => {
    const help = renderServerHelp()
    expect(help).toContain('Usage: orca-ide [serve] [options]')
    for (const flag of [
      '--port',
      '--listen',
      '--pairing-address',
      '--data-dir',
      '--no-pairing',
      '--json'
    ]) {
      expect(help).toContain(flag)
    }
  })
})
