#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  connectToApp,
  launchDevApp,
  pickFreePort,
  stopDevApp,
  waitForStoreReady
} from '../../config/scripts/windows-apphang-repro/electron-dev-session.mjs'
import { safeRemoveLocalDirectory } from '../../config/scripts/windows-apphang-repro/wsl-workspace-fixture.mjs'
import { ARM_NAMES, armRunners, resetEnvironment } from './terminal-reveal-raster-arms.mjs'
import { analyzeAttempt } from './terminal-reveal-raster-attempt.mjs'
import {
  createRevealFixture,
  createRevealUserDataDirectory,
  setupRevealWorkspaces
} from './terminal-reveal-raster-fixture.mjs'
import {
  activateTab,
  activateWorktree,
  activeTabId,
  createPressureTabs,
  installRevealRasterProbe,
  pinProbeToActivePane,
  readViewport,
  runStaticFixture,
  splitTabPanes
} from './terminal-reveal-raster-session.mjs'

const PARK_DELAY_MS = 1_500
const DEFAULT_ARMS = ['control', 'tab', 'warm', 'cold']
const FIXTURE_MODES = ['static', 'atlas', 'sync-tui']

function parseArgs() {
  const args = {
    arms: DEFAULT_ARMS,
    cycles: 3,
    pressureTabs: 18,
    pressureSplits: 0,
    captureMs: 2_200,
    // Validates the blank-pane detector against a synthetic dead canvas; never
    // set for a real verification run.
    injectBlankMs: 0,
    fixture: 'static',
    output: null,
    noHoldSync: false,
    keepProfile: false
  }
  for (const arg of process.argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      console.log(
        `Usage: node tests/tools/terminal-reveal-raster-repro.mjs [--arms=${ARM_NAMES.join(',')}] [--cycles=N] [--pressure-tabs=N] [--pressure-splits=N] [--capture-ms=N] [--fixture=${FIXTURE_MODES.join('|')}] [--inject-blank-ms=N] [--no-hold-sync] [--output=dir] [--keep-profile]`
      )
      process.exit(0)
    }
    if (arg === '--keep-profile') {
      args.keepProfile = true
      continue
    }
    // Isolates the harness's forced DEC 2026 hold from the fixture's own stream.
    if (arg === '--no-hold-sync') {
      args.noHoldSync = true
      continue
    }
    const [name, value] = arg.split('=', 2)
    if (name === '--arms') {
      args.arms = (value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => ARM_NAMES.includes(item))
    } else if (name === '--cycles') {
      args.cycles = Math.max(1, Number(value) || 3)
    } else if (name === '--pressure-tabs') {
      args.pressureTabs = Math.max(1, Number(value) || 18)
    } else if (name === '--pressure-splits') {
      args.pressureSplits = Math.max(0, Number(value) || 0)
    } else if (name === '--capture-ms') {
      args.captureMs = Math.max(750, Number(value) || 2_200)
    } else if (name === '--fixture') {
      if (!FIXTURE_MODES.includes(value)) {
        throw new Error(`Unknown fixture ${value}; expected one of ${FIXTURE_MODES.join(', ')}`)
      }
      args.fixture = value
    } else if (name === '--inject-blank-ms') {
      args.injectBlankMs = Math.max(0, Number(value) || 0)
    } else if (name === '--output') {
      args.output = value || null
    }
  }
  if (args.arms.length === 0) {
    throw new Error('At least one valid arm is required')
  }
  return args
}

function summarize(attempts) {
  const byArm = {}
  for (const attempt of attempts) {
    const bucket = (byArm[attempt.arm] ??= {
      valid: 0,
      invalid: 0,
      reproducedStrict: 0,
      reproducedScaled: 0,
      reproducedStaleBox: 0,
      notReproduced: 0,
      detectorConfirmed: 0,
      detectorFailed: 0,
      blankPane: 0
    })
    if (attempt.status === 'invalid-run') {
      bucket.invalid += 1
      continue
    }
    bucket.valid += 1
    if (attempt.status === 'reproduced-strict') {
      bucket.reproducedStrict += 1
    } else if (attempt.status === 'reproduced-scaled') {
      bucket.reproducedScaled += 1
    } else if (attempt.status === 'reproduced-stale-box') {
      bucket.reproducedStaleBox += 1
    } else if (attempt.status === 'not-reproduced') {
      bucket.notReproduced += 1
    } else if (attempt.status === 'detector-confirmed') {
      bucket.detectorConfirmed += 1
    } else if (attempt.status === 'detector-failed') {
      bucket.detectorFailed += 1
    } else if (attempt.status === 'blank-pane') {
      bucket.blankPane += 1
    }
  }
  return byArm
}

function verdictFor(attempts) {
  // Any arm, control included: a pane that paints nothing outranks every blur
  // verdict below and must not be reported as a clean run.
  if (attempts.some((attempt) => attempt.status === 'blank-pane')) {
    return 'blank-pane'
  }
  const natural = attempts.filter((attempt) => attempt.arm !== 'control')
  if (natural.some((attempt) => attempt.status === 'reproduced-strict')) {
    return 'reproduced-strict'
  }
  if (natural.some((attempt) => attempt.status === 'reproduced-scaled')) {
    return 'reproduced-scaled'
  }
  if (natural.some((attempt) => attempt.status === 'reproduced-stale-box')) {
    return 'reproduced-stale-box'
  }
  return natural.some((attempt) => attempt.status === 'not-reproduced')
    ? 'not-observed'
    : 'inconclusive'
}

async function buildContext(page, args, workspaces, cdp) {
  await activateWorktree(page, workspaces.target.id)
  const targetTabId = await activeTabId(page)
  if (!targetTabId) {
    throw new Error('Target worktree has no active terminal tab')
  }
  await runStaticFixture(page, targetTabId, args.fixtureScriptPath)
  const targetPtyId = await pinProbeToActivePane(page, targetTabId)
  const pressureTabIds = await createPressureTabs(page, workspaces.target.id, args.pressureTabs)
  for (const tabId of args.pressureSplits > 0 ? pressureTabIds : []) {
    await splitTabPanes(page, tabId, args.pressureSplits)
  }
  await activateTab(page, targetTabId)
  return {
    targetTabId,
    targetPtyId,
    siblingTabId: pressureTabIds.at(-1),
    targetWorktreeId: workspaces.target.id,
    decoyWorktreeId: workspaces.decoy.id,
    primaryWorktreeId: workspaces.primary.id,
    captureMs: args.captureMs,
    // Only the sync fixture models a TUI that holds DEC 2026 across a reveal.
    holdSync: args.fixture === 'sync-tui' && !args.noHoldSync,
    injectBlankMs: args.injectBlankMs,
    pressureTabIds,
    cdp
  }
}

async function main() {
  const args = parseArgs()
  const startedAt = Date.now()
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-')
  const outputDirectory = path.resolve(
    args.output ?? path.join(os.tmpdir(), `orca-terminal-reveal-raster-${stamp}`)
  )
  mkdirSync(outputDirectory, { recursive: true })
  const report = {
    startedAt: new Date(startedAt).toISOString(),
    platform: `${process.platform} ${os.release()}`,
    args,
    parkingDelayMs: PARK_DELAY_MS,
    attempts: [],
    cleanupErrors: []
  }
  let fixture = null
  let userDataDir = null
  let launched = null
  let browser = null
  try {
    fixture = createRevealFixture(args.fixture)
    userDataDir = createRevealUserDataDirectory()
    process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS = String(PARK_DELAY_MS)
    const cdpPort = await pickFreePort()
    console.log(`[reveal-raster] output=${outputDirectory} cdp=${cdpPort} fixture=${args.fixture}`)
    launched = launchDevApp({ cdpPort, userDataDir })
    const connected = await connectToApp(cdpPort)
    browser = connected.browser
    const page = connected.page
    await waitForStoreReady(page)
    await installRevealRasterProbe(page)
    const controlCdp = await page.context().newCDPSession(page)
    const workspaces = await setupRevealWorkspaces(page, fixture)
    const context = await buildContext(
      page,
      { ...args, fixtureScriptPath: fixture.scriptPath },
      workspaces,
      controlCdp
    )
    report.fixture = {
      mode: args.fixture,
      targetTabId: context.targetTabId,
      pressureTabCount: context.pressureTabIds.length,
      viewport: await readViewport(page),
      managerCount: await page.evaluate(() => window.__paneManagers?.size ?? null)
    }
    console.log(`[reveal-raster] viewport=${JSON.stringify(report.fixture.viewport)}`)
    for (let cycle = 0; cycle < args.cycles; cycle += 1) {
      for (const arm of args.arms) {
        console.log(`[reveal-raster] cycle=${cycle + 1} arm=${arm}`)
        const attempt = await armRunners[arm](page, context)
        const directory = path.join(outputDirectory, `${arm}-${String(cycle + 1).padStart(2, '0')}`)
        const result = analyzeAttempt({ arm, attempt, directory })
        report.attempts.push({ cycle: cycle + 1, ...result })
        console.log(
          `[reveal-raster] cycle=${cycle + 1} arm=${arm} status=${result.status} frames=${result.strictFrameCount}/${result.eligibleFrameCount}/${result.compositorFrameCount}`
        )
        await resetEnvironment(page, context)
      }
    }
    report.verdict = verdictFor(report.attempts)
    report.summaryByArm = summarize(report.attempts)
    report.blankPane = report.attempts.some((attempt) => attempt.status === 'blank-pane')
      ? 'detected'
      : 'clean'
    const controls = report.attempts.filter((attempt) => attempt.arm === 'control')
    report.detector = controls.length
      ? controls.every((attempt) => attempt.status === 'detector-confirmed')
        ? 'confirmed'
        : 'failed'
      : 'not-run'
  } finally {
    report.elapsedMs = Date.now() - startedAt
    if (browser) {
      await browser.close().catch(() => undefined)
    }
    if (launched) {
      await stopDevApp(launched.child).catch((error) => {
        report.cleanupErrors.push(error instanceof Error ? error.message : String(error))
      })
      report.appLogsTail = launched.logs.slice(-80)
    }
    if (!args.keepProfile) {
      if (fixture) {
        safeRemoveLocalDirectory(fixture.baseDir, report.cleanupErrors)
      }
      if (userDataDir) {
        safeRemoveLocalDirectory(userDataDir, report.cleanupErrors)
      }
    }
    writeFileSync(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(`[reveal-raster] verdict=${report.verdict ?? 'harness-error'}`)
    console.log(`[reveal-raster] detector=${report.detector ?? 'unknown'}`)
    console.log(`[reveal-raster] blank-pane=${report.blankPane ?? 'unknown'}`)
    console.log(`[reveal-raster] report=${path.join(outputDirectory, 'report.json')}`)
  }
  if (report.detector === 'failed' || report.blankPane === 'detected') {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
