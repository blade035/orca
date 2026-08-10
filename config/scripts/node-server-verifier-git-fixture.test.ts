import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listWorktreesStrict } from '../../src/main/git/worktree'
import { initializeNodeServerVerifierGitWorkspace } from './node-server-verifier-git-fixture'
import { isSameExistingHostPath } from './node-server-verifier-host-path'

describe('node server verifier Git fixture', () => {
  it('creates a born repository visible to the strict worktree scan', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-verifier-git-')))
    const repoPath = join(root, 'repo')
    try {
      initializeNodeServerVerifierGitWorkspace(repoPath)

      const head = execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', 'HEAD'], {
        encoding: 'utf8'
      })
      const worktrees = await listWorktreesStrict(repoPath)

      expect(head.trim()).not.toBe('')
      expect(worktrees.some((worktree) => isSameExistingHostPath(worktree.path, repoPath))).toBe(
        true
      )
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})
