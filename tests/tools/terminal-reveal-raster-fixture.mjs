import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { pollUntil } from '../../config/scripts/windows-apphang-repro/repro-timing.mjs'
import { createCompletedOnboardingProfile } from '../../config/scripts/windows-apphang-repro/wsl-workspace-fixture.mjs'

const shortRoot = path.join(os.homedir(), '.orca-reveal-repro')
export const FIXTURE_MARKER = 'ORCA TERMINAL RASTER REVEAL PROBE'

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

const READABLE_LINES = [
  FIXTURE_MARKER,
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ  abcdefghijklmnopqrstuvwxyz',
  '0123456789  !@#$%^&*()_+-=[]{};:,.<>/?',
  'MMMMMMMMMMMM  WWWWWWWWWWWW  IIIIIIIIIIII  llllllllllll',
  'B8B8B8B8B8B8  O0O0O0O0O0O0  rnmrnmrnmrnm  il1il1il1il1',
  'quick brown fox jumps over the lazy dog  QUICK BROWN FOX',
  'vertical |||||||||| horizontal ========================',
  'pixel proof: stable buffer + stable grid + degraded raster',
  'glyph cores should stay solid while terminal panes reveal',
  'red green blue cyan magenta yellow white gray foreground'
]

// Distinct glyph/colour pairs are the texture-atlas cache key, so a screen of
// unique pairs forces multi-page atlas allocation and re-upload on every reset.
function atlasChurnScreen() {
  const glyphs = [
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    ...'!@#$%^&*()_+-=[]{};:,.<>/?|\\~`',
    ...'┌┐└┘├┤┬┴┼─│╔╗╚╝╠╣╦╩╬═║▀▄█▌▐░▒▓',
    ...'àéîõüñçßøåæÐÞµ¶§©®±×÷¤¥£¢'
  ]
  const rows = []
  let index = 0
  for (let row = 0; row < 60; row += 1) {
    let line = ''
    for (let column = 0; column < 150; column += 1) {
      const glyph = glyphs[index % glyphs.length]
      const colour = 17 + (index % 214)
      const attribute = index % 4 === 1 ? '1;' : index % 4 === 3 ? '3;' : ''
      line += `\u001b[${attribute}38;5;${colour}m${glyph}`
      index += 1
    }
    rows.push(line)
  }
  return rows
}

function fixtureOutput(mode) {
  const readable = Array.from({ length: 3 }, () => READABLE_LINES.join('\r\n')).join('\r\n')
  if (mode !== 'atlas') {
    return `\u001b[2J\u001b[H\u001b[?25l\u001b[38;2;242;242;242m${readable}\u001b[0m`
  }
  const churn = atlasChurnScreen().join('\r\n')
  return `\u001b[2J\u001b[H\u001b[?25l\u001b[38;2;242;242;242m${READABLE_LINES[0]}\u001b[0m\r\n${churn}\u001b[0m`
}

// Redraw cadence. Slow enough that a blank window is measurable before the next
// ESU heals it, fast enough to bound how long a forced hold can suppress paint.
const SYNC_TUI_REDRAW_MS = 350

// One BSU/ESU pair per frame, the way an agent TUI actually draws: sync is held
// only for the write, never between frames. An earlier revision re-asserted BSU
// on a 40 ms heartbeat to guarantee the mode spanned a reveal; that made the
// hold effectively permanent, and a terminal that never paints while DEC 2026 is
// held is spec-correct, not broken — it produced durable "blank" panes on a clean
// tree and would have been reported as a product defect. The reveal-time overlap
// is forced deliberately instead, by the probe's holdSync, which this cadence
// then releases within one frame.
function syncTuiScript() {
  const lines = Array.from({ length: 3 }, () => READABLE_LINES).flat()
  return [
    "const BSU = '\\u001b[?2026h'",
    "const ESU = '\\u001b[?2026l'",
    `const LINES = ${JSON.stringify(lines)}`,
    '// Re-measured per frame: hidden-time layout changes resize the pty, and a',
    '// frame taller than the grid would scroll and drift the pinned buffer hash.',
    'const frame = () =>',
    "  '\\u001b[H\\u001b[J\\u001b[38;2;242;242;242m' +",
    "  LINES.slice(0, Math.max(1, (process.stdout.rows || 24) - 1)).join('\\r\\n') +",
    "  '\\u001b[0m'",
    "process.stdout.write('\\u001b[2J\\u001b[H\\u001b[?25l')",
    'process.stdout.write(BSU + frame() + ESU)',
    `setInterval(() => process.stdout.write(BSU + frame() + ESU), ${SYNC_TUI_REDRAW_MS})`,
    ''
  ].join('\n')
}

export function createRevealFixture(mode = 'static') {
  mkdirSync(shortRoot, { recursive: true })
  const baseDir = mkdtempSync(path.join(shortRoot, 'fx-'))
  const repoPath = path.join(baseDir, 'repo')
  mkdirSync(repoPath, { recursive: true })
  git(repoPath, 'init')
  git(repoPath, 'config', 'user.email', 'repro@orca.local')
  git(repoPath, 'config', 'user.name', 'Orca Repro')
  writeFileSync(path.join(repoPath, 'README.md'), '# terminal reveal raster fixture\n')
  git(repoPath, 'add', '.')
  git(repoPath, 'commit', '-m', 'init', '--no-gpg-sign')
  git(repoPath, 'branch', '-M', 'main')
  const scriptPath = path.join(baseDir, 'static-terminal-fixture.cjs')
  writeFileSync(
    scriptPath,
    mode === 'sync-tui'
      ? syncTuiScript()
      : `process.stdout.write(Buffer.from('${Buffer.from(fixtureOutput(mode)).toString('base64')}','base64'))\nsetInterval(() => {}, 2147483647)\n`
  )
  return { baseDir, repoPath, scriptPath, mode }
}

export function createRevealUserDataDirectory() {
  mkdirSync(shortRoot, { recursive: true })
  const userDataDir = mkdtempSync(path.join(shortRoot, 'ud-'))
  createCompletedOnboardingProfile(userDataDir)
  return userDataDir
}

export async function setupRevealWorkspaces(page, fixture) {
  const setup = await page.evaluate(
    async ({ repoPath }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      await store.getState().fetchSettings?.()
      await store.getState().updateSettings?.({
        terminalGpuAcceleration: 'on',
        terminalHiddenViewParking: true
      })
      const addResult = await window.api.repos.add({
        path: repoPath,
        kind: 'git'
      })
      if ('error' in addResult) {
        throw new Error(addResult.error)
      }
      await store.getState().fetchRepos()
      const state = store.getState()
      const repo = state.repos.find((candidate) => candidate.path === repoPath) ?? addResult.repo
      await store.getState().fetchWorktrees(repo.id, { requireAuthoritative: true })
      const next = store.getState()
      next.setSidebarOpen(true)
      next.setGroupBy('none')
      next.setSortBy('recent')
      next.setShowActiveOnly(false)
      next.setActiveView('terminal')
      const target = await next.createWorktree(
        repo.id,
        `terminal-reveal-raster-${Date.now()}`,
        undefined,
        'inherit'
      )
      const decoy = await store
        .getState()
        .createWorktree(repo.id, `terminal-reveal-decoy-${Date.now()}`, undefined, 'inherit')
      await store.getState().fetchWorktrees(repo.id, { requireAuthoritative: true })
      return {
        repoId: repo.id,
        targetWorktreeId: target.worktree.id,
        decoyWorktreeId: decoy.worktree.id
      }
    },
    { repoPath: fixture.repoPath }
  )
  const worktrees = await pollUntil(
    'fixture worktrees',
    () =>
      page.evaluate(async (repoId) => {
        await window.__store
          ?.getState()
          .fetchWorktrees?.(repoId, { requireAuthoritative: true })
          .catch(() => undefined)
        return (window.__store?.getState().worktreesByRepo?.[repoId] ?? []).map((worktree) => ({
          id: worktree.id,
          path: worktree.path,
          isMainWorktree: worktree.isMainWorktree
        }))
      }, setup.repoId),
    (items) => Array.isArray(items) && items.length >= 3,
    30_000,
    300
  )
  const primary = worktrees.find((worktree) => worktree.isMainWorktree) ?? worktrees[0]
  const target = worktrees.find((worktree) => worktree.id === setup.targetWorktreeId)
  const decoy = worktrees.find((worktree) => worktree.id === setup.decoyWorktreeId)
  if (!primary || !target || !decoy) {
    throw new Error(`Expected three fixture worktrees, found ${worktrees.length}`)
  }
  return { primary, target, decoy }
}
