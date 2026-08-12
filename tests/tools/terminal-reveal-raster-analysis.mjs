import { PNG } from 'pngjs'

const DIFF_DISTANCE = 48
const INK_DISTANCE = 48
const CORE_DISTANCE = 150

function pixelDistance(data, offset, background) {
  return (
    Math.abs((data[offset] ?? 0) - background.red) +
    Math.abs((data[offset + 1] ?? 0) - background.green) +
    Math.abs((data[offset + 2] ?? 0) - background.blue)
  )
}

function dominantBackground(image) {
  const histogram = new Map()
  for (let y = 0; y < image.height; y += 4) {
    for (let x = 0; x < image.width; x += 4) {
      const offset = (y * image.width + x) * 4
      const red = (image.data[offset] ?? 0) >> 3
      const green = (image.data[offset + 1] ?? 0) >> 3
      const blue = (image.data[offset + 2] ?? 0) >> 3
      const key = `${red},${green},${blue}`
      histogram.set(key, (histogram.get(key) ?? 0) + 1)
    }
  }
  const entry = [...histogram.entries()].sort((left, right) => right[1] - left[1])[0]
  if (!entry) {
    throw new Error('Raster has no pixels')
  }
  const [red, green, blue] = entry[0].split(',').map((part) => Number(part) * 8 + 4)
  return { red, green, blue }
}

function luma(data, offset) {
  return (
    (data[offset] ?? 0) * 0.2126 +
    (data[offset + 1] ?? 0) * 0.7152 +
    (data[offset + 2] ?? 0) * 0.0722
  )
}

function edgeEnergy(image) {
  let energy = 0
  for (let y = 0; y < image.height - 1; y += 1) {
    for (let x = 0; x < image.width - 1; x += 1) {
      const offset = (y * image.width + x) * 4
      energy += Math.abs(luma(image.data, offset) - luma(image.data, offset + 4))
      energy += Math.abs(luma(image.data, offset) - luma(image.data, offset + image.width * 4))
    }
  }
  return energy
}

export function cropTerminalRaster(buffer, clip, viewport) {
  const source = PNG.sync.read(buffer)
  const scaleX = source.width / viewport.width
  const scaleY = source.height / viewport.height
  const x0 = Math.max(0, Math.floor(clip.x * scaleX))
  const y0 = Math.max(0, Math.floor(clip.y * scaleY))
  const x1 = Math.min(source.width, Math.ceil((clip.x + clip.width) * scaleX))
  const y1 = Math.min(source.height, Math.ceil((clip.y + clip.height) * scaleY))
  if (x1 <= x0 || y1 <= y0) {
    throw new Error('Terminal clip falls outside the compositor frame')
  }
  const target = new PNG({ width: x1 - x0, height: y1 - y0 })
  PNG.bitblt(source, target, x0, y0, target.width, target.height, 0, 0)
  return PNG.sync.write(target)
}

function resample(source, width, height) {
  const target = new PNG({ width, height })
  const scaleX = source.width / width
  const scaleY = source.height / height
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor((y + 0.5) * scaleY))
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor((x + 0.5) * scaleX))
      const from = (sourceY * source.width + sourceX) * 4
      const to = (y * width + x) * 4
      target.data[to] = source.data[from] ?? 0
      target.data[to + 1] = source.data[from + 1] ?? 0
      target.data[to + 2] = source.data[from + 2] ?? 0
      target.data[to + 3] = 255
    }
  }
  return PNG.sync.write(target)
}

/**
 * Rescales a candidate to the baseline's pixel box before comparing. A stale
 * pane surface holds the right characters at the wrong pitch, so it only lines
 * up with the healed raster once the scale difference is undone — which is the
 * measurement that separates "same text, wrong scale" from "different text".
 */
export function compareScaledRevealRaster(baselineBuffer, candidateBuffer) {
  const baseline = PNG.sync.read(baselineBuffer)
  const candidate = PNG.sync.read(candidateBuffer)
  const scaled = resample(candidate, baseline.width, baseline.height)
  return {
    ...compareRevealRaster(baselineBuffer, scaled),
    sourceWidth: candidate.width,
    sourceHeight: candidate.height,
    scaleX: candidate.width / baseline.width,
    scaleY: candidate.height / baseline.height
  }
}

export function compareRevealRaster(baselineBuffer, candidateBuffer) {
  const baseline = PNG.sync.read(baselineBuffer)
  const candidate = PNG.sync.read(candidateBuffer)
  if (baseline.width !== candidate.width || baseline.height !== candidate.height) {
    return {
      comparable: false,
      width: candidate.width,
      height: candidate.height,
      expectedWidth: baseline.width,
      expectedHeight: baseline.height
    }
  }

  const background = dominantBackground(baseline)
  let diffPixels = 0
  let baselineInkPixels = 0
  let candidateInkPixels = 0
  let candidateInkAtBaselinePixels = 0
  let baselineCorePixels = 0
  let candidateCorePixels = 0
  let candidateCoreAtBaselinePixels = 0
  for (let offset = 0; offset < baseline.data.length; offset += 4) {
    const rgbaDiff =
      Math.abs((baseline.data[offset] ?? 0) - (candidate.data[offset] ?? 0)) +
      Math.abs((baseline.data[offset + 1] ?? 0) - (candidate.data[offset + 1] ?? 0)) +
      Math.abs((baseline.data[offset + 2] ?? 0) - (candidate.data[offset + 2] ?? 0)) +
      Math.abs((baseline.data[offset + 3] ?? 0) - (candidate.data[offset + 3] ?? 0))
    if (rgbaDiff > DIFF_DISTANCE) {
      diffPixels += 1
    }
    const baselineDistance = pixelDistance(baseline.data, offset, background)
    const candidateDistance = pixelDistance(candidate.data, offset, background)
    if (candidateDistance >= INK_DISTANCE) {
      candidateInkPixels += 1
    }
    if (candidateDistance >= CORE_DISTANCE) {
      candidateCorePixels += 1
    }
    if (baselineDistance >= INK_DISTANCE) {
      baselineInkPixels += 1
      if (candidateDistance >= INK_DISTANCE) {
        candidateInkAtBaselinePixels += 1
      }
    }
    if (baselineDistance >= CORE_DISTANCE) {
      baselineCorePixels += 1
      if (candidateDistance >= CORE_DISTANCE) {
        candidateCoreAtBaselinePixels += 1
      }
    }
  }
  const pixelCount = baseline.width * baseline.height
  const baselineEdgeEnergy = edgeEnergy(baseline)
  const candidateEdgeEnergy = edgeEnergy(candidate)
  return {
    comparable: true,
    width: candidate.width,
    height: candidate.height,
    diffPixels,
    diffRatio: pixelCount ? diffPixels / pixelCount : 1,
    baselineInkPixels,
    candidateInkPixels,
    inkVolumeRatio: baselineInkPixels ? candidateInkPixels / baselineInkPixels : 0,
    inkRetention: baselineInkPixels ? candidateInkAtBaselinePixels / baselineInkPixels : 0,
    baselineCorePixels,
    candidateCorePixels,
    coreVolumeRatio: baselineCorePixels ? candidateCorePixels / baselineCorePixels : 0,
    coreRetention: baselineCorePixels ? candidateCoreAtBaselinePixels / baselineCorePixels : 0,
    baselineEdgeEnergy,
    edgeRetention: baselineEdgeEnergy ? candidateEdgeEnergy / baselineEdgeEnergy : 0
  }
}

export function isDegradedRevealRaster(metrics) {
  return (
    metrics.comparable === true &&
    metrics.baselineCorePixels >= 100 &&
    metrics.diffRatio >= 0.008 &&
    metrics.inkVolumeRatio >= 0.7 &&
    metrics.inkVolumeRatio <= 2.2 &&
    metrics.coreRetention <= 0.86 &&
    (metrics.edgeRetention <= 0.92 ||
      metrics.coreVolumeRatio <= 0.8 ||
      metrics.inkRetention <= 0.65)
  )
}

export function isHealedRevealRaster(metrics) {
  return (
    metrics.comparable === true &&
    metrics.diffRatio <= 0.006 &&
    metrics.coreRetention >= 0.94 &&
    metrics.edgeRetention >= 0.94 &&
    metrics.edgeRetention <= 1.06
  )
}

// A blank pane is a flat fill, so it is identified by absence rather than by
// colour: none of the baseline's glyph cores survive and the surface carries
// essentially no edge energy. Both hold whether the dead canvas composites as
// the theme background, black, or transparent — and neither holds for blur,
// which keeps its cores and most of its edges. Deliberately not an ink test:
// a black fill under a dark-grey theme reads as full ink, not zero.
const BLANK_EDGE_RETENTION = 0.06
const BLANK_CORE_RETENTION = 0.05

export function isBlankRevealRaster(metrics) {
  return (
    metrics.comparable === true &&
    metrics.baselineCorePixels >= 100 &&
    metrics.baselineEdgeEnergy > 0 &&
    metrics.edgeRetention <= BLANK_EDGE_RETENTION &&
    metrics.coreRetention <= BLANK_CORE_RETENTION
  )
}

// Absolute ink/edge for a single raster. The retention metrics are ratios, so
// they go blind when a pane is still dead at reference time: blank-vs-blank
// reads as a perfect match. Proven by fault injection, where a durably blank
// pane scored diffRatio 0 against its own blank reference.
export function measureRasterInk(buffer) {
  const image = PNG.sync.read(buffer)
  const background = dominantBackground(image)
  let inkPixels = 0
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (pixelDistance(image.data, offset, background) >= INK_DISTANCE) {
      inkPixels += 1
    }
  }
  const pixels = image.width * image.height
  return {
    inkPixels,
    inkRatio: pixels ? inkPixels / pixels : 0,
    edgeEnergy: edgeEnergy(image),
    edgePerPixel: pixels ? edgeEnergy(image) / pixels : 0,
    pixels
  }
}

const DEAD_REFERENCE_INK_RATIO = 0.001
const DEAD_REFERENCE_EDGE_PER_PIXEL = 0.5

/**
 * A settled pane whose terminal buffer holds text but whose raster carries no
 * ink and no edge energy never came back — the worst outcome the campaign can
 * measure, and the one a ratio against that same raster cannot see.
 */
export function isDeadRevealReference(ink, state) {
  return Boolean(
    ink &&
    (state?.nonblankCells ?? 0) >= 200 &&
    ink.inkRatio <= DEAD_REFERENCE_INK_RATIO &&
    ink.edgePerPixel <= DEAD_REFERENCE_EDGE_PER_PIXEL
  )
}

/** Longest run of consecutive blank frames, or null when the pane never blanked. */
export function findBlankPaneWindow(frames) {
  let longest = null
  let run = []
  const close = () => {
    if (run.length > 0 && (!longest || run.length > longest.length)) {
      longest = run
    }
    run = []
  }
  for (const frame of frames) {
    if (isBlankRevealRaster(frame.metrics)) {
      run.push(frame)
      continue
    }
    close()
  }
  close()
  if (!longest) {
    return null
  }
  const worst = longest.reduce((left, right) =>
    (left.metrics.edgeRetention ?? 1) <= (right.metrics.edgeRetention ?? 1) ? left : right
  )
  return {
    frameCount: longest.length,
    startMs: longest[0].elapsedMs,
    endMs: longest.at(-1).elapsedMs,
    durationMs: longest.at(-1).elapsedMs - longest[0].elapsedMs,
    backingStableFrameCount: longest.filter((frame) => frame.backingStable).length,
    sample: worst
  }
}

function canvasSignature(state) {
  return (state?.canvases ?? []).map(
    (canvas) => `${canvas.identity}:${canvas.width}x${canvas.height}`
  )
}

/**
 * Reports which renderer-side facts moved between two sampled states. An empty
 * list means the raster changed with nothing in the DOM, grid, or backing store
 * to explain it, which is the compositor-only signature the campaign is after.
 */
export function compareRevealStates(left, right) {
  const changed = []
  const scalar = ['bufferHash', 'cols', 'rows', 'dpr', 'terminalIdentity', 'managerIdentity']
  for (const key of scalar) {
    if (left?.[key] !== right?.[key]) {
      changed.push(key)
    }
  }
  for (const key of ['x', 'y', 'width', 'height']) {
    if (Math.abs((left?.screenClip?.[key] ?? 0) - (right?.screenClip?.[key] ?? 0)) > 1) {
      changed.push(`screenClip.${key}`)
    }
  }
  const leftCanvases = canvasSignature(left)
  const rightCanvases = canvasSignature(right)
  if (leftCanvases.join('|') !== rightCanvases.join('|')) {
    changed.push('canvasBacking')
  }
  return { changed, leftCanvases, rightCanvases }
}

export function findDegradeThenHeal(frames) {
  for (let suspectIndex = 0; suspectIndex < frames.length; suspectIndex += 1) {
    const suspect = frames[suspectIndex]
    if (!suspect.stateStable || !isDegradedRevealRaster(suspect.metrics)) {
      continue
    }
    let consecutiveHealed = 0
    for (let index = suspectIndex + 1; index < frames.length; index += 1) {
      const frame = frames[index]
      consecutiveHealed =
        frame.stateStable && isHealedRevealRaster(frame.metrics) ? consecutiveHealed + 1 : 0
      if (consecutiveHealed >= 2) {
        return { suspect, healed: frame }
      }
    }
  }
  return null
}
