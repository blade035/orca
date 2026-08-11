import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import packageJson from '../../package.json' with { type: 'json' }
import { readNpmRuntimeVersion } from './npm-runtime-version'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('npm runtime version', () => {
  it('reads the installed package manifest beside dist', async () => {
    const runtimeDirectory = await createFixture('1.5.0', '1.4.0')

    expect(readNpmRuntimeVersion(runtimeDirectory)).toBe('1.5.0')
  })

  it('falls back to the repository manifest for source execution', () => {
    expect(readNpmRuntimeVersion()).toBe(packageJson.version)
  })

  it('rejects an invalid installed version without using the source fallback', async () => {
    const runtimeDirectory = await createFixture('latest', '1.4.0')

    expect(() => readNpmRuntimeVersion(runtimeDirectory)).toThrow(
      'npm_runtime_package_version_invalid'
    )
  })
})

async function createFixture(installedVersion: string, fallbackVersion: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-runtime-version-'))
  const packageRoot = join(root, 'installed')
  const runtimeDirectory = join(packageRoot, 'dist')
  await mkdir(runtimeDirectory, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: installedVersion }))
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: fallbackVersion }))
  roots.push(root)
  return runtimeDirectory
}
