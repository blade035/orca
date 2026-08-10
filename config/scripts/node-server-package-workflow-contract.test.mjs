import { readFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveNodeServerNpmInvocation } from './node-server-npm-invocation.mjs'

const dockerfile = readFileSync(join('config', 'docker', 'node-server', 'Dockerfile'), 'utf8')

describe('Node server package workflow contract', () => {
  it('verifies the selected Node archive before extracting it', () => {
    const checksumDownload = dockerfile.indexOf('SHASUMS256.txt')
    const checksumVerification = dockerfile.indexOf('sha256sum -c -')
    const extraction = dockerfile.indexOf('tar -xJf "$archive"')

    expect(checksumDownload).toBeGreaterThanOrEqual(0)
    expect(checksumVerification).toBeGreaterThan(checksumDownload)
    expect(extraction).toBeGreaterThan(checksumVerification)
    expect(dockerfile).toContain('grep "  ${archive}$" SHASUMS256.txt')
  })

  it('invokes the adjacent npm CLI through Node on Windows', () => {
    const executablePath = win32.join('C:\\', 'node', 'node.exe')
    const invocation = resolveNodeServerNpmInvocation({
      platform: 'win32',
      executablePath,
      pathExists: vi.fn(() => true)
    })

    expect(invocation).toEqual({
      command: executablePath,
      prefixArgs: [win32.join('C:\\', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    })
  })

  it('uses npm directly outside Windows', () => {
    expect(resolveNodeServerNpmInvocation({ platform: 'linux' })).toEqual({
      command: 'npm',
      prefixArgs: []
    })
  })

  it('fails before packing when the adjacent Windows npm CLI is absent', () => {
    expect(() =>
      resolveNodeServerNpmInvocation({
        platform: 'win32',
        executablePath: win32.join('C:\\', 'node', 'node.exe'),
        pathExists: () => false
      })
    ).toThrow('npm CLI is missing beside Node')
  })
})
