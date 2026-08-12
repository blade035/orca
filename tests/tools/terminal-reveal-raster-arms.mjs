import {
  activateTab,
  activateWorktree,
  activeTabId,
  applyDeviceMetrics,
  captureCompositorTransition,
  captureStableReference,
  clearDeviceMetrics,
  closeExtraPanes,
  holdSynchronizedOutput,
  injectBlankFault,
  readTargetState,
  readViewport,
  setSidebarOpen,
  settleFrames,
  splitTabPanes,
  waitForParkedTarget,
  waitForTabManager
} from './terminal-reveal-raster-session.mjs'

const WARM_HIDE_MS = 300
const HIDDEN_MUTATION_SETTLE_MS = 450
const RAPID_SWITCH_ROUNDS = 4

async function ensureTargetVisible(page, context) {
  const state = await readTargetState(page, context.targetTabId)
  if (state?.activeWorktreeId !== context.targetWorktreeId) {
    await activateWorktree(page, context.targetWorktreeId)
  }
  if ((await activeTabId(page)) !== context.targetTabId) {
    await activateTab(page, context.targetTabId)
  }
  await waitForTabManager(page, context.targetTabId)
}

async function prepareAttempt(page, context) {
  await ensureTargetVisible(page, context)
  const stable = await captureStableReference(page, context.targetTabId, 2)
  return stable.at(-1).state
}

function finish(precondition, preBaseline, capture, stableCaptures, options = {}) {
  return {
    precondition,
    preBaseline,
    capture,
    stableCaptures,
    requireBaselineMatch: options.requireBaselineMatch !== false,
    hiddenMutation: options.hiddenMutation ?? null
  }
}

// Hides the target behind another worktree; the manager stays mounted with
// rendering suspended (warm) unless parking evicts it (cold).
async function hideWarm(page, context) {
  await activateWorktree(page, context.primaryWorktreeId)
  await page.waitForTimeout(WARM_HIDE_MS)
  return readTargetState(page, context.targetTabId)
}

async function hideCold(page, context) {
  await activateWorktree(page, context.decoyWorktreeId)
  const decoyTabId = await activeTabId(page)
  if (decoyTabId) {
    await waitForTabManager(page, decoyTabId)
  }
  await activateWorktree(page, context.primaryWorktreeId)
  try {
    return await waitForParkedTarget(page, context.targetTabId)
  } catch {
    return readTargetState(page, context.targetTabId)
  }
}

function warmPreconditionValid(observed) {
  return Boolean(
    observed?.managerPresent &&
    observed.parked === false &&
    observed.renderingSuspended === true &&
    observed.renderingDiagnostics?.webglAttachmentDeferred === true &&
    observed.renderer === 'dom'
  )
}

function coldPreconditionValid(observed) {
  return Boolean(observed?.parked === true && observed.managerPresent === false)
}

async function revealAndCapture(page, context, precondition, preBaseline, options) {
  if (context.holdSync) {
    await holdSynchronizedOutput(page, context.targetTabId)
  }
  if (context.injectBlankMs > 0) {
    await injectBlankFault(page, context.targetTabId, context.injectBlankMs)
  }
  const capture = await captureCompositorTransition(
    page,
    context.targetTabId,
    context.captureMs,
    () => activateWorktree(page, context.targetWorktreeId)
  )
  const stableCaptures = await captureStableReference(page, context.targetTabId)
  return finish(precondition, preBaseline, capture, stableCaptures, options)
}

async function runControlArm(page, context) {
  const preBaseline = await prepareAttempt(page, context)
  const precondition = {
    valid: Boolean(preBaseline?.targetActive && preBaseline.managerPresent),
    observed: preBaseline,
    synthetic: true
  }
  const capture = await captureCompositorTransition(
    page,
    context.targetTabId,
    context.captureMs,
    () =>
      page.evaluate(
        ({ tabId, ptyId }) => {
          const manager = window.__paneManagers?.get(tabId)
          const panes = manager?.getPanes?.() ?? []
          // Must blur the pane the probe samples, not whichever pane holds focus.
          const pane =
            panes.find((entry) => entry?.container?.dataset?.ptyId === ptyId) ?? panes[0] ?? null
          const screen = pane?.container?.querySelector('.xterm-screen')
          if (!(screen instanceof HTMLElement)) {
            throw new Error('No terminal screen for detector control')
          }
          screen.style.filter = 'blur(1.4px)'
          setTimeout(() => {
            screen.style.filter = ''
          }, 420)
        },
        { tabId: context.targetTabId, ptyId: context.targetPtyId }
      )
  )
  const stableCaptures = await captureStableReference(page, context.targetTabId)
  return finish(precondition, preBaseline, capture, stableCaptures)
}

async function runTabArm(page, context) {
  const preBaseline = await prepareAttempt(page, context)
  await activateTab(page, context.siblingTabId)
  const observed = await readTargetState(page, context.targetTabId)
  const precondition = {
    valid: Boolean(observed?.managerPresent && observed.parked !== true),
    observed,
    synthetic: false
  }
  if (context.holdSync) {
    await holdSynchronizedOutput(page, context.targetTabId)
  }
  const capture = await captureCompositorTransition(
    page,
    context.targetTabId,
    context.captureMs,
    () => activateTab(page, context.targetTabId)
  )
  const stableCaptures = await captureStableReference(page, context.targetTabId)
  return finish(precondition, preBaseline, capture, stableCaptures)
}

async function runWarmArm(page, context) {
  const preBaseline = await prepareAttempt(page, context)
  const observed = await hideWarm(page, context)
  return revealAndCapture(
    page,
    context,
    { valid: warmPreconditionValid(observed), observed, synthetic: false },
    preBaseline
  )
}

async function runColdArm(page, context) {
  const preBaseline = await prepareAttempt(page, context)
  const observed = await hideCold(page, context)
  return revealAndCapture(
    page,
    context,
    { valid: coldPreconditionValid(observed), observed, synthetic: false },
    preBaseline
  )
}

// Layout width changes while the target is display:none are invisible to the
// pane's ResizeObserver, so reveal composites the pre-hide backing store into
// the new box until a fit repairs it.
function hiddenLayoutArm({ hide, validate, mutate, label }) {
  return async (page, context) => {
    const preBaseline = await prepareAttempt(page, context)
    const observed = await hide(page, context)
    const mutation = await mutate(page, context)
    await page.waitForTimeout(HIDDEN_MUTATION_SETTLE_MS)
    const afterMutation = await readTargetState(page, context.targetTabId)
    return revealAndCapture(
      page,
      context,
      { valid: validate(observed), observed, synthetic: false },
      preBaseline,
      {
        requireBaselineMatch: false,
        hiddenMutation: { label, mutation, afterMutation }
      }
    )
  }
}

async function toggleSidebar(page) {
  await setSidebarOpen(page, false)
  return { sidebarOpen: false }
}

async function shrinkViewport(page, context) {
  const viewport = await readViewport(page)
  const width = Math.max(900, Math.round(viewport.width * 0.72))
  await applyDeviceMetrics(context.cdp, {
    width,
    height: viewport.height,
    deviceScaleFactor: viewport.dpr
  })
  await settleFrames(page, 3)
  return { from: viewport, toWidth: width }
}

async function raiseDeviceScaleFactor(page, context) {
  const viewport = await readViewport(page)
  const next = viewport.dpr >= 2 ? 1 : 2
  await applyDeviceMetrics(context.cdp, {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: next
  })
  await settleFrames(page, 3)
  return { fromDpr: viewport.dpr, toDpr: next }
}

async function splitHiddenPanes(page, context) {
  const created = await splitTabPanes(page, context.targetTabId, 1)
  return { extraPanes: created }
}

// The app relays every hidden->visible window reveal to main, which answers with
// a +1px size jiggle; that resize lands on whatever pane geometry exists at the
// time, hidden panes included.
async function requestWindowRepaint(page) {
  const delivered = await page.evaluate(() => {
    const notify = window.api?.ui?.notifyWindowRevealed
    if (typeof notify !== 'function') {
      return false
    }
    notify()
    return true
  })
  if (!delivered) {
    throw new Error('Window reveal relay is unavailable in this build')
  }
  await settleFrames(page, 6)
  return { relay: 'ui:window-revealed' }
}

async function runWindowRepaintArm(page, context) {
  const preBaseline = await prepareAttempt(page, context)
  const capture = await captureCompositorTransition(
    page,
    context.targetTabId,
    context.captureMs,
    () => requestWindowRepaint(page)
  )
  const stableCaptures = await captureStableReference(page, context.targetTabId)
  return finish(
    {
      valid: Boolean(preBaseline?.targetActive && preBaseline.managerPresent),
      observed: preBaseline,
      synthetic: false
    },
    preBaseline,
    capture,
    stableCaptures
  )
}

// Users flick between worktrees faster than reveal settles; each switch restarts
// the fit/atlas pipeline on a pane that never finished the previous one.
async function runRapidSwitchArm(page, context) {
  const preBaseline = await prepareAttempt(page, context)
  for (let index = 0; index < RAPID_SWITCH_ROUNDS; index += 1) {
    await activateWorktree(page, context.primaryWorktreeId)
    await activateWorktree(page, context.targetWorktreeId)
  }
  await activateWorktree(page, context.primaryWorktreeId)
  const observed = await readTargetState(page, context.targetTabId)
  return revealAndCapture(
    page,
    context,
    { valid: Boolean(observed), observed, synthetic: false },
    preBaseline,
    {
      requireBaselineMatch: false,
      hiddenMutation: { label: 'rapid-switch', mutation: { rounds: RAPID_SWITCH_ROUNDS } }
    }
  )
}

export async function resetEnvironment(page, context) {
  await clearDeviceMetrics(context.cdp)
  await setSidebarOpen(page, true)
  await closeExtraPanes(page, context.targetTabId, context.targetPtyId)
  await settleFrames(page, 3)
  await page.waitForTimeout(200)
}

export const armRunners = {
  control: runControlArm,
  tab: runTabArm,
  warm: runWarmArm,
  cold: runColdArm,
  'warm-sidebar': hiddenLayoutArm({
    label: 'sidebar-collapse',
    hide: hideWarm,
    validate: warmPreconditionValid,
    mutate: toggleSidebar
  }),
  'cold-sidebar': hiddenLayoutArm({
    label: 'sidebar-collapse',
    hide: hideCold,
    validate: coldPreconditionValid,
    mutate: toggleSidebar
  }),
  'warm-resize': hiddenLayoutArm({
    label: 'viewport-shrink',
    hide: hideWarm,
    validate: warmPreconditionValid,
    mutate: shrinkViewport
  }),
  'cold-resize': hiddenLayoutArm({
    label: 'viewport-shrink',
    hide: hideCold,
    validate: coldPreconditionValid,
    mutate: shrinkViewport
  }),
  'warm-dpr': hiddenLayoutArm({
    label: 'device-scale-change',
    hide: hideWarm,
    validate: warmPreconditionValid,
    mutate: raiseDeviceScaleFactor
  }),
  'cold-dpr': hiddenLayoutArm({
    label: 'device-scale-change',
    hide: hideCold,
    validate: coldPreconditionValid,
    mutate: raiseDeviceScaleFactor
  }),
  'warm-split': hiddenLayoutArm({
    label: 'hidden-pane-split',
    hide: hideWarm,
    validate: warmPreconditionValid,
    mutate: splitHiddenPanes
  }),
  jiggle: runWindowRepaintArm,
  rapid: runRapidSwitchArm,
  'warm-jiggle': hiddenLayoutArm({
    label: 'window-repaint-jiggle',
    hide: hideWarm,
    validate: warmPreconditionValid,
    mutate: requestWindowRepaint
  }),
  'cold-jiggle': hiddenLayoutArm({
    label: 'window-repaint-jiggle',
    hide: hideCold,
    validate: coldPreconditionValid,
    mutate: requestWindowRepaint
  })
}

export const ARM_NAMES = Object.keys(armRunners)
