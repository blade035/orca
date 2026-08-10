import { linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSameExistingHostPath } from './node-server-verifier-host-path'

describe('node server verifier host path identity', () => {
  it('recognizes different paths to the same filesystem object', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-verifier-path-'))
    const original = join(root, 'original')
    const alias = join(root, 'alias')
    try {
      writeFileSync(original, 'same object')
      linkSync(original, alias)

      expect(isSameExistingHostPath(original, alias)).toBe(true)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('rejects different or missing filesystem objects', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-verifier-path-'))
    const left = join(root, 'left')
    const right = join(root, 'right')
    try {
      writeFileSync(left, 'left')
      writeFileSync(right, 'right')

      expect(isSameExistingHostPath(left, right)).toBe(false)
      expect(isSameExistingHostPath(left, join(root, 'missing'))).toBe(false)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})
