import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  compareRevealRaster,
  compareRevealStates,
  compareScaledRevealRaster,
  cropTerminalRaster,
  findBlankPaneWindow,
  findDegradeThenHeal,
  isBlankRevealRaster,
  isDeadRevealReference,
  isHealedRevealRaster,
  measureRasterInk
} from './terminal-reveal-raster-analysis.mjs'

// Cold reveals remount the manager before they can present, so the cap only has
// to prove the capture caught the reveal itself rather than a later frame.
const MAX_ACTIVATION_MS = 1_500
const MIN_STALE_BOX_MS = 100
// One-frame flat frames happen at compositor swap; a pane that is actually dead
// stays dead until something repaints it.
const MIN_BLANK_FRAMES = 2
const MIN_BLANK_MS = 50
const MIN_RESCALED_INK_RETENTION = 0.5
const MAX_STATE_GAP_MS = 50

function sameGeometry(left, right) {
  return (
    left?.cols === right?.cols &&
    left?.rows === right?.rows &&
    left?.dpr === right?.dpr &&
    left?.screenClip &&
    right?.screenClip &&
    Math.abs(left.screenClip.x - right.screenClip.x) <= 1 &&
    Math.abs(left.screenClip.y - right.screenClip.y) <= 1 &&
    Math.abs(left.screenClip.width - right.screenClip.width) <= 1 &&
    Math.abs(left.screenClip.height - right.screenClip.height) <= 1
  )
}

function sameCanvasBacking(left, right) {
  const leftCanvases = left?.canvases ?? []
  const rightCanvases = right?.canvases ?? []
  if (leftCanvases.length !== rightCanvases.length || leftCanvases.length === 0) {
    return false
  }
  return leftCanvases.every((canvas, index) => {
    const other = rightCanvases[index]
    return (
      canvas.identity === other?.identity &&
      canvas.width === other?.width &&
      canvas.height === other?.height
    )
  })
}

function sameCanvasIdentity(left, right) {
  const leftIds = (left?.canvases ?? []).map((canvas) => canvas.identity).join(',')
  const rightIds = (right?.canvases ?? []).map((canvas) => canvas.identity).join(',')
  return leftIds.length > 0 && leftIds === rightIds
}

// The revealed pane keeps its pre-hide surface size for a while: same terminal,
// same buffer, same grid, but a canvas box that no longer matches the layout, so
// the compositor scales the old raster into the new slot.
function measureStaleBoxWindow(frames, stableState, referenceCrop) {
  const stale = frames.filter(
    (frame) =>
      frame.crop &&
      frame.state?.bufferHash === stableState?.bufferHash &&
      frame.state?.cols === stableState?.cols &&
      frame.state?.rows === stableState?.rows &&
      frame.state?.dpr === stableState?.dpr &&
      sameCanvasIdentity(frame.state, stableState) &&
      !sameCanvasBacking(frame.state, stableState)
  )
  if (stale.length === 0 || !referenceCrop) {
    return null
  }
  const middle = stale[Math.floor(stale.length / 2)]
  return {
    frameCount: stale.length,
    startMs: stale[0].elapsedMs,
    endMs: stale.at(-1).elapsedMs,
    durationMs: stale.at(-1).elapsedMs - stale[0].elapsedMs,
    staleBacking: (middle.state.canvases ?? []).map((canvas) => `${canvas.width}x${canvas.height}`),
    healedBacking: (stableState.canvases ?? []).map((canvas) => `${canvas.width}x${canvas.height}`),
    sample: jsonFrame(middle),
    rescaledMetrics: compareScaledRevealRaster(referenceCrop, middle.crop),
    sampleCrop: middle.crop
  }
}

function nearestState(states, capturedAt) {
  let nearest = null
  let gapMs = Number.POSITIVE_INFINITY
  for (const state of states) {
    const gap = Math.abs(state.wallAt - capturedAt)
    if (gap < gapMs) {
      nearest = state
      gapMs = gap
    }
  }
  return { state: nearest, gapMs }
}

function jsonFrame(frame) {
  return {
    index: frame.index,
    capturedAt: frame.capturedAt,
    elapsedMs: frame.elapsedMs,
    stateGapMs: frame.stateGapMs,
    stateStable: frame.stateStable,
    backingStable: frame.backingStable,
    blank: isBlankRevealRaster(frame.metrics),
    metrics: frame.metrics,
    state: frame.state
  }
}

function transitionEvidence(transition) {
  if (!transition) {
    return null
  }
  const delta = compareRevealStates(transition.suspect.state, transition.healed.state)
  return {
    degraded: jsonFrame(transition.suspect),
    healed: jsonFrame(transition.healed),
    healDelayMs: transition.healed.elapsedMs - transition.suspect.elapsedMs,
    stateDelta: delta
  }
}

function buildFrames(capture, reference, stableState) {
  const viewport = reference?.viewport
  const frames = []
  if (!reference?.crop || !viewport) {
    return frames
  }
  for (const [index, rawFrame] of capture.frames.entries()) {
    if (rawFrame.capturedAt < capture.actionAt) {
      continue
    }
    const paired = nearestState(capture.states, rawFrame.capturedAt)
    const state = paired.state
    if (!state?.targetActive || !state.screenClip) {
      continue
    }
    let crop = null
    let metrics = { comparable: false, reason: 'crop-failed' }
    try {
      crop = cropTerminalRaster(rawFrame.buffer, state.screenClip, viewport)
      metrics = compareRevealRaster(reference.crop, crop)
    } catch (error) {
      metrics = {
        comparable: false,
        reason: error instanceof Error ? error.message : String(error)
      }
    }
    const stateStable =
      paired.gapMs <= MAX_STATE_GAP_MS &&
      state.bufferHash === stableState?.bufferHash &&
      sameGeometry(state, stableState)
    frames.push({
      index,
      capturedAt: rawFrame.capturedAt,
      elapsedMs: rawFrame.capturedAt - capture.actionAt,
      stateGapMs: paired.gapMs,
      stateStable,
      backingStable: stateStable && sameCanvasBacking(state, stableState),
      state,
      metrics,
      crop
    })
  }
  return frames
}

// The pane can re-measure its grid before its canvas box follows, so the glyphs
// are drawn at the old pitch inside the new column count until the box catches
// up. That window is measurable from the probe samples alone.
function measureRevealSettle(capture, stableState) {
  const active = capture.states.filter((state) => state.targetActive)
  const activeAt = active[0]?.wallAt ?? null
  if (activeAt === null) {
    return null
  }
  const gridAt = active.find(
    (state) => state.cols === stableState?.cols && state.rows === stableState?.rows
  )?.wallAt
  const boxAt = active.find(
    (state) => sameGeometry(state, stableState) && sameCanvasBacking(state, stableState)
  )?.wallAt
  return {
    activeAfterActionMs: activeAt - capture.actionAt,
    gridSettleMs: gridAt === undefined ? null : gridAt - activeAt,
    boxSettleMs: boxAt === undefined ? null : boxAt - activeAt,
    gridBeforeBoxMs: gridAt === undefined || boxAt === undefined ? null : boxAt - gridAt
  }
}

function prepareReference(stableCaptures) {
  const prepared = stableCaptures.map((entry) => ({
    ...entry,
    crop: entry.state?.screenClip
      ? cropTerminalRaster(entry.buffer, entry.state.screenClip, entry.viewport)
      : null
  }))
  const reference = prepared.at(-1)
  const stableState = reference?.state
  const noise = []
  for (let index = 1; index < prepared.length; index += 1) {
    const previous = prepared[index - 1]
    const current = prepared[index]
    if (previous.crop && current.crop) {
      noise.push(compareRevealRaster(previous.crop, current.crop))
    }
  }
  const issues = []
  if (!reference?.crop) {
    issues.push('no-reference-crop')
  }
  if (!stableState?.targetActive) {
    issues.push('target-inactive')
  }
  if (!stableState?.bufferHash) {
    issues.push('no-buffer-hash')
  }
  if ((stableState?.nonblankCells ?? 0) < 200) {
    issues.push(`sparse-buffer:${stableState?.nonblankCells ?? 0}`)
  }
  if (prepared.some((entry) => !entry.crop)) {
    issues.push('crop-failed')
  }
  if (prepared.some((entry) => entry.state?.bufferHash !== stableState?.bufferHash)) {
    issues.push('buffer-drift')
  }
  if (prepared.some((entry) => !sameGeometry(entry.state, stableState))) {
    issues.push('geometry-drift')
  }
  if (!noise.every(isHealedRevealRaster)) {
    issues.push('reference-noise')
  }
  return { prepared, reference, stableState, noise, valid: issues.length === 0, issues }
}

function writeAttemptEvidence(directory, result, capture, prepared) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'stable.png'), prepared.at(-1).crop)
  writeFileSync(
    path.join(directory, 'state.jsonl'),
    `${capture.states.map((state) => JSON.stringify(state)).join('\n')}\n`
  )
  writeFileSync(
    path.join(directory, 'metrics.json'),
    `${JSON.stringify(result.frames.map(jsonFrame), null, 2)}\n`
  )
  const strict = result.strictTransition
  const relaxed = result.geometryStableTransition
  if (strict) {
    writeFileSync(path.join(directory, 'degraded-strict.png'), strict.suspect.crop)
    writeFileSync(path.join(directory, 'healed-strict.png'), strict.healed.crop)
  }
  if (relaxed) {
    writeFileSync(path.join(directory, 'degraded.png'), relaxed.suspect.crop)
    writeFileSync(path.join(directory, 'healed.png'), relaxed.healed.crop)
  }
  if (result.worst) {
    writeFileSync(path.join(directory, 'worst.png'), result.worst.crop)
  }
  if (result.staleBox) {
    writeFileSync(path.join(directory, 'stale-box.png'), result.staleBox.sampleCrop)
  }
  if (result.blankPane?.sample?.crop) {
    writeFileSync(path.join(directory, 'blank-pane.png'), result.blankPane.sample.crop)
  }
}

function blankPaneQualifies(blankPane) {
  return Boolean(
    blankPane && blankPane.frameCount >= MIN_BLANK_FRAMES && blankPane.durationMs >= MIN_BLANK_MS
  )
}

function staleBoxQualifies(staleBox) {
  return Boolean(
    staleBox &&
    staleBox.durationMs >= MIN_STALE_BOX_MS &&
    staleBox.rescaledMetrics?.comparable &&
    staleBox.rescaledMetrics.inkRetention >= MIN_RESCALED_INK_RETENTION
  )
}

function statusFor({
  arm,
  valid,
  deadReference,
  strictTransition,
  geometryStableTransition,
  staleBox,
  blankPane
}) {
  // Ahead of validity: a pane still dead once everything settled invalidates its
  // own reference, so treating that as a harness problem would swallow the very
  // worst result the campaign can produce.
  if (deadReference) {
    return 'blank-pane'
  }
  if (!valid) {
    return 'invalid-run'
  }
  // Ahead of the blur verdicts, including the control's: a pane that paints
  // nothing is a strictly worse outcome than one that paints blurred, and the
  // blur detector cannot see it (no ink means no degraded-then-healed pair).
  if (blankPaneQualifies(blankPane)) {
    return 'blank-pane'
  }
  if (arm === 'control') {
    return strictTransition ? 'detector-confirmed' : 'detector-failed'
  }
  if (strictTransition) {
    return 'reproduced-strict'
  }
  if (geometryStableTransition) {
    return 'reproduced-scaled'
  }
  return staleBoxQualifies(staleBox) ? 'reproduced-stale-box' : 'not-reproduced'
}

export function analyzeAttempt({ arm, attempt, directory }) {
  const { precondition, preBaseline, capture, stableCaptures } = attempt
  const referenceInfo = prepareReference(stableCaptures)
  const { reference, stableState } = referenceInfo
  const baselineMatches = Boolean(
    preBaseline?.bufferHash === stableState?.bufferHash && sameGeometry(preBaseline, stableState)
  )
  const referenceInk = reference?.crop ? measureRasterInk(reference.crop) : null
  const deadReference = isDeadRevealReference(referenceInk, stableState)
  const frames = buildFrames(capture, reference, stableState)
  const eligibleFrames = frames.filter((frame) => frame.stateStable && frame.metrics.comparable)
  const strictFrames = eligibleFrames.filter((frame) => frame.backingStable)
  const geometryStableTransition = findDegradeThenHeal(eligibleFrames)
  const strictTransition = findDegradeThenHeal(strictFrames)
  const worst = eligibleFrames
    .filter((frame) => frame.crop)
    .sort(
      (left, right) =>
        (left.metrics.coreRetention ?? Number.POSITIVE_INFINITY) -
        (right.metrics.coreRetention ?? Number.POSITIVE_INFINITY)
    )[0]
  const firstVisibleMs = eligibleFrames[0]?.elapsedMs ?? null
  const revealSettle = measureRevealSettle(capture, stableState)
  const staleBox = measureStaleBoxWindow(frames, stableState, reference?.crop)
  const blankPane = findBlankPaneWindow(eligibleFrames)
  // Gate on when the pane went live, not on when it first matched the healed
  // geometry — a long stale window is the defect, so it must not void the run.
  const valid =
    precondition.valid &&
    referenceInfo.valid &&
    (attempt.requireBaselineMatch ? baselineMatches : true) &&
    eligibleFrames.length >= 2 &&
    revealSettle !== null &&
    revealSettle.activeAfterActionMs <= MAX_ACTIVATION_MS
  const status = statusFor({
    arm,
    valid,
    deadReference,
    strictTransition,
    geometryStableTransition,
    staleBox,
    blankPane
  })
  const result = { frames, strictTransition, geometryStableTransition, worst, staleBox, blankPane }
  writeAttemptEvidence(directory, result, capture, referenceInfo.prepared)
  return {
    arm,
    status,
    precondition,
    hiddenMutation: attempt.hiddenMutation,
    requireBaselineMatch: attempt.requireBaselineMatch,
    stableReferenceValid: referenceInfo.valid,
    stableReferenceIssues: referenceInfo.issues,
    referenceInk,
    deadReference,
    baselineMatches,
    stableNoise: referenceInfo.noise,
    compositorFrameCount: capture.frames.length,
    eligibleFrameCount: eligibleFrames.length,
    strictFrameCount: strictFrames.length,
    firstVisibleMs,
    revealSettle,
    staleBox: staleBox ? { ...staleBox, sampleCrop: undefined } : null,
    blankPane: blankPane ? { ...blankPane, sample: jsonFrame(blankPane.sample) } : null,
    blankFrameCount: eligibleFrames.filter((frame) => isBlankRevealRaster(frame.metrics)).length,
    strictTransition: transitionEvidence(strictTransition),
    scaledTransition: transitionEvidence(geometryStableTransition),
    worstFrame: worst ? jsonFrame(worst) : null,
    evidenceDirectory: directory
  }
}
