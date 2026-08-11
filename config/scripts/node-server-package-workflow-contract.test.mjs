import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveNodeServerNpmInvocation } from './node-server-npm-invocation.mjs'

const dockerfile = readFileSync(join('config', 'docker', 'node-server', 'Dockerfile'), 'utf8')
const releaseWorkflow = readFileSync(join('.github', 'workflows', 'release-cut.yml'), 'utf8')

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

  it('publishes the exact verified package through npm trusted publishing', () => {
    expect(releaseWorkflow).toMatch(/publish-npm-server:\n[\s\S]*?id-token: write/)
    expect(releaseWorkflow).toContain('pnpm run verify:node-server-package')
    expect(releaseWorkflow).toContain('pnpm run verify:node-server-docker -- --ubuntu 20.04')
    expect(releaseWorkflow).toMatch(
      /publish-npm-server:[\s\S]*?verify-release-required-assets\.mjs/
    )
    expect(releaseWorkflow).toContain('npm 11.5.1 or newer is required for trusted publishing')
    expect(releaseWorkflow).toContain(
      'npm publish "$archive" --access public --tag "$dist_tag" --provenance'
    )
    expect(releaseWorkflow).toContain('different immutable bytes')
    expect(releaseWorkflow).toMatch(/publish-release:\n[\s\S]*?- publish-npm-server/)
  })

  it('advances rc only for an unsuffixed release candidate', () => {
    expect(releaseWorkflow).toContain(
      'if [[ "$version" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+-rc\\.(0|[1-9][0-9]*)$ ]]'
    )
    expect(releaseWorkflow).toContain('dist_tag=rc')
    expect(releaseWorkflow).toContain('elif [[ "$version" == *-* ]]')
    expect(releaseWorkflow).toContain('dist_tag=build')
    expect(releaseWorkflow).toContain('dist_tag=latest')
  })

  it('repairs the expected dist-tag when an immutable publish is retried', () => {
    const immutableMatch = releaseWorkflow.indexOf(
      '@stablyai/orca@$version is already published with the expected bytes.'
    )
    const tagRead = releaseWorkflow.indexOf(
      'npm view "@stablyai/orca" dist-tags --json --prefer-online'
    )
    const oidcExchange = releaseWorkflow.indexOf(
      '/-/npm/v1/oidc/token/exchange/package/%40stablyai%2Forca'
    )
    const tagRepair = releaseWorkflow.indexOf(
      'npm dist-tag add "@stablyai/orca@$version" "$dist_tag"'
    )
    const repairedTagCheck = releaseWorkflow.indexOf('repaired_tag_version=')

    expect(tagRead).toBeGreaterThan(immutableMatch)
    expect(oidcExchange).toBeGreaterThan(tagRead)
    expect(tagRepair).toBeGreaterThan(oidcExchange)
    expect(repairedTagCheck).toBeGreaterThan(tagRepair)
    expect(releaseWorkflow).toContain('NODE_AUTH_TOKEN="$npm_token" npm dist-tag add')
    expect(releaseWorkflow).toContain('node - "$version" "$remote_tag_version"')
    expect(releaseWorkflow).toContain('compare(candidate, current) > 0')
    expect(releaseWorkflow).toContain(
      'npm dist-tag $dist_tag already points to newer $remote_tag_version; leaving it unchanged.'
    )
    expect(releaseWorkflow.indexOf('compare(candidate, current) > 0')).toBeLessThan(oidcExchange)
  })

  it('never repairs a dist-tag backward', () => {
    const match = releaseWorkflow.match(
      /node - "\$version" "\$remote_tag_version" <<'NODE'\n([\s\S]*?)\n {10}NODE/
    )
    expect(match?.[1]).toBeDefined()
    const comparisonScript = match?.[1]?.replace(/^ {10}/gm, '') ?? ''
    const cases = [
      ['1.5.0', '1.4.9', 0],
      ['1.4.9', '1.5.0', 1],
      ['1.5.0-rc.4', '1.5.0-rc.3', 0],
      ['1.5.0-rc.3', '1.5.0-rc.4', 1],
      ['1.5.0', '1.5.0-rc.9', 0],
      ['1.5.0-rc.9', '1.5.0', 1],
      ['1.5.0-rc.4.perf', '1.5.0-rc.4', 0]
    ]

    for (const [candidate, current, expectedStatus] of cases) {
      const result = spawnSync(process.execPath, ['-', candidate, current], {
        input: comparisonScript
      })
      expect(result.status, `${candidate} compared with ${current}`).toBe(expectedStatus)
    }
  })
})
