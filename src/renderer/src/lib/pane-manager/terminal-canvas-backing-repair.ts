import type { ManagedPane } from './pane-manager-types'
import { recordTerminalWebglDiagnostic } from '../../../../shared/terminal-webgl-diagnostics'
import { readFitClientSize } from './pane-fit-client-size'
import { forceRepaintThroughRenderPause } from './terminal-render-pause-release'

/**
 * Why: xterm's WebGL canvas can be left holding a backing store that no longer
 * matches the box it is composited into, and the browser silently rescales the
 * stale bitmap to fit. Two proven ways in:
 *
 *  - devicePixelRatio changed while the pane was hidden (window moved between
 *    retina/non-retina displays, then the worktree revealed) — the addon's own
 *    device-pixel observer misses changes that land while the element has no
 *    box. Proven live: backing 2160 px for a 1080 css box at dpr 1.
 *  - the grid was re-fitted while `RenderService._isPaused` was still true (a
 *    layout change made behind `display:none`, then reveal). RenderService
 *    defers the renderer's `handleResize` onto an idle task there, so the
 *    freshly measured cols/rows land on the buffer while the canvas keeps its
 *    pre-hide backing and `.xterm-screen` box — the same text at the wrong
 *    pitch with thin gray stems, for up to ~1.3 s under load.
 *
 * Both are one defect: the backing store disagrees with what the current grid
 * and dpr require. The repair is xterm's own resize path, driven straight on
 * the renderer so a paused render service cannot defer it again.
 */
type XtermRendererInternals = {
  _canvas?: HTMLCanvasElement
  _gl?: { canvas?: HTMLCanvasElement }
  dimensions?: {
    device?: {
      canvas?: { width?: number; height?: number }
      cell?: { width?: number; height?: number }
    }
  }
  handleDevicePixelRatioChange?: () => void
  handleResize?: (cols: number, rows: number) => void
}

type BackingSize = { width: number; height: number }

type XtermCoreInternals = {
  _renderService?: { _renderer?: { value?: XtermRendererInternals } }
  _charSizeService?: { hasValidSize?: boolean }
}

function getPaneXtermCore(pane: ManagedPane): XtermCoreInternals | undefined {
  return (pane.terminal as unknown as { _core?: XtermCoreInternals })._core
}

// Why: `_updateDimensions` bails before writing anything when the char size is
// not measured, so `handleResize` would re-apply the same stale numbers — the
// mismatch is real but unfixable, and retrying it on every fit would churn a
// full resize plus a forced repaint per divider-drag frame. Leave it to the
// fit that follows a successful measure.
function canRendererRecomputeDimensions(core: XtermCoreInternals | undefined): boolean {
  const hasValidSize = core?._charSizeService?.hasValidSize
  return hasValidSize !== false
}

// Why recompute rather than trust `device.canvas`: xterm derives that field from
// cols x cell when it last ran `_updateDimensions`, so it goes stale alongside
// the canvas whenever a resize is deferred behind a paused render service. Cell
// metrics only move on font/dpr changes, which the css-box predicate covers.
function expectedBackingForGrid(
  renderer: XtermRendererInternals,
  pane: ManagedPane
): BackingSize | null {
  const device = renderer.dimensions?.device
  const cellWidth = device?.cell?.width ?? 0
  const cellHeight = device?.cell?.height ?? 0
  const { cols, rows } = pane.terminal
  if (cellWidth > 0 && cellHeight > 0 && cols > 0 && rows > 0) {
    return { width: cols * cellWidth, height: rows * cellHeight }
  }
  const canvasWidth = device?.canvas?.width ?? 0
  const canvasHeight = device?.canvas?.height ?? 0
  return canvasWidth > 0 && canvasHeight > 0 ? { width: canvasWidth, height: canvasHeight } : null
}

// Why the inline style and not getBoundingClientRect: the renderer writes the
// css size and the backing size in the same pass, so the style is that css box
// verbatim — and this predicate runs on every successful fit, where forcing
// layout would be a real cost.
function expectedBackingForCssBox(canvas: HTMLCanvasElement, dpr: number): BackingSize | null {
  const cssWidth = Number.parseFloat(canvas.style.width)
  const cssHeight = Number.parseFloat(canvas.style.height)
  if (!(cssWidth > 0) || !(cssHeight > 0)) {
    return null
  }
  return { width: Math.round(cssWidth * dpr), height: Math.round(cssHeight * dpr) }
}

function backingMatches(canvas: HTMLCanvasElement, expected: BackingSize, dpr: number): boolean {
  // xterm rounds its css canvas size before converting back to device pixels
  // (drift <= dpr/2), and the addon's `device-pixel-content-box` observer then
  // writes the compositor's own rounding of that box straight into canvas.width
  // while deliberately leaving `dimensions.device.canvas` on the exact cell
  // multiple (+/- 1 more). At fractional dpr — Windows 125/150/175 %, scaled
  // Retina modes — that steady-state gap exceeds ceil(dpr/2), so the extra pixel
  // is what keeps a healthy pane from refitting on every fit. The real defect
  // drifts by hundreds of device pixels, so this stays far from masking it.
  const tolerance = Math.max(1, Math.ceil(dpr / 2) + 1)
  return (
    Math.abs(canvas.width - expected.width) <= tolerance &&
    Math.abs(canvas.height - expected.height) <= tolerance
  )
}

export function repairPaneWebglCanvasBackingMismatch(pane: ManagedPane): boolean {
  const core = getPaneXtermCore(pane)
  const renderer = core?._renderService?._renderer?.value
  const canvas = renderer?._canvas ?? renderer?._gl?.canvas
  if (!renderer || !canvas?.isConnected || !canRendererRecomputeDimensions(core)) {
    return false
  }
  const dpr = canvas.ownerDocument?.defaultView?.devicePixelRatio ?? 0
  if (!(dpr > 0)) {
    return false
  }
  const grid = expectedBackingForGrid(renderer, pane)
  const cssBox = expectedBackingForCssBox(canvas, dpr)
  // Report whichever expectation the backing actually failed, so the breadcrumb
  // names the real drift rather than a value that already agreed.
  let expected: BackingSize | null = null
  if (grid && !backingMatches(canvas, grid, dpr)) {
    expected = grid
  } else if (cssBox && !backingMatches(canvas, cssBox, dpr)) {
    expected = cssBox
  }
  if (!expected) {
    return false
  }
  // Why only now: a hidden pane keeps its pre-hide backing on purpose, and
  // resizing it there clears the canvas with nothing able to repaint it. Kept
  // behind the mismatch check so the common matching case costs no layout.
  const box = readFitClientSize(pane)
  if (!box || box.width <= 0 || box.height <= 0) {
    return false
  }
  const staleBackingWidth = canvas.width
  const staleBackingHeight = canvas.height
  try {
    // Order matters: refresh the renderer's cached dpr/dimensions first, then
    // the resize path recreates the backing store and layer sizes from them.
    renderer.handleDevicePixelRatioChange?.()
    renderer.handleResize?.(pane.terminal.cols, pane.terminal.rows)
    // Why forced: resizing a canvas clears it, and reveal usually runs while
    // xterm's IntersectionObserver still reports paused — a plain refresh is
    // swallowed there, trading the rescaled frame for a blank one.
    if (!forceRepaintThroughRenderPause(pane.terminal)) {
      pane.terminal.refresh(0, pane.terminal.rows - 1)
    }
  } catch {
    // Pane may be mid-teardown; the next reveal/fit retries the check.
    return false
  }
  recordTerminalWebglDiagnostic('webgl-canvas-backing-repair', {
    paneId: pane.id,
    staleBackingWidth,
    staleBackingHeight,
    expectedBackingWidth: expected.width,
    expectedBackingHeight: expected.height,
    devicePixelRatio: dpr
  })
  return true
}
