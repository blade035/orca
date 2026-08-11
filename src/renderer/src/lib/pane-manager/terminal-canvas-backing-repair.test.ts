import { describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from './pane-manager-types'
import { repairPaneWebglCanvasBackingMismatch } from './terminal-canvas-backing-repair'

type PaneArgs = {
  backingWidth: number
  dpr: number
  backingHeight?: number
  /** Renderer device cell metrics; the grid predicate is cols/rows x these. */
  cellWidth?: number
  cellHeight?: number
  cols?: number
  rows?: number
  /** Stale `dimensions.device.canvas`, used only when cell metrics are absent. */
  deviceCanvasWidth?: number
  deviceCanvasHeight?: number
  /** Inline css box the renderer last wrote; defaults to backing / dpr. */
  cssWidth?: number
  cssHeight?: number
  connected?: boolean
  hasRenderer?: boolean
  paneBox?: { width: number; height: number } | null
  paused?: boolean
  charSizeValid?: boolean
}

function makePane(args: PaneArgs): {
  pane: ManagedPane
  handleDevicePixelRatioChange: ReturnType<typeof vi.fn>
  handleResize: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
  refreshRows: ReturnType<typeof vi.fn>
} {
  const handleDevicePixelRatioChange = vi.fn()
  const handleResize = vi.fn()
  const refresh = vi.fn()
  const refreshRows = vi.fn()
  const backingHeight = args.backingHeight ?? 1200
  const cols = args.cols ?? 120
  const rows = args.rows ?? 40
  const canvas = {
    width: args.backingWidth,
    height: backingHeight,
    isConnected: args.connected ?? true,
    ownerDocument: { defaultView: { devicePixelRatio: args.dpr } },
    style: {
      width: `${args.cssWidth ?? Math.round(args.backingWidth / args.dpr)}px`,
      height: `${args.cssHeight ?? Math.round(backingHeight / args.dpr)}px`
    },
    getBoundingClientRect: () => {
      throw new Error('repair detection must not force layout on the canvas')
    }
  }
  const hasCellMetrics = args.cellWidth != null && args.cellHeight != null
  const renderer =
    (args.hasRenderer ?? true)
      ? {
          _canvas: canvas,
          dimensions: {
            device: {
              cell: hasCellMetrics ? { width: args.cellWidth, height: args.cellHeight } : undefined,
              canvas: {
                width: args.deviceCanvasWidth ?? 0,
                height: args.deviceCanvasHeight ?? 0
              }
            }
          },
          handleDevicePixelRatioChange,
          handleResize
        }
      : undefined
  const box = args.paneBox === undefined ? { width: 1080, height: 600 } : args.paneBox
  const container = box
    ? { getBoundingClientRect: () => ({ width: box.width, height: box.height }) }
    : {}
  const pane = {
    id: 1,
    container,
    terminal: {
      cols,
      rows,
      refresh,
      _core: {
        _charSizeService: { hasValidSize: args.charSizeValid ?? true },
        _renderService: {
          _renderer: { value: renderer },
          _isPaused: args.paused ?? false,
          refreshRows
        }
      }
    }
  } as unknown as ManagedPane
  return { pane, handleDevicePixelRatioChange, handleResize, refresh, refreshRows }
}

describe('repairPaneWebglCanvasBackingMismatch', () => {
  it('repairs a stale dpr-2 backing composited on a dpr-1 display', () => {
    // The originally reproduced field bug: a hidden-time display change leaves a
    // 2160px backing behind a 1080px css box at dpr 1 (half-size/smeared text).
    const { pane, handleDevicePixelRatioChange, handleResize, refresh } = makePane({
      backingWidth: 2160,
      backingHeight: 1200,
      cssWidth: 1080,
      cssHeight: 600,
      dpr: 1,
      cellWidth: 9,
      cellHeight: 15
    })

    expect(repairPaneWebglCanvasBackingMismatch(pane)).toBe(true)
    expect(handleDevicePixelRatioChange).toHaveBeenCalledTimes(1)
    expect(handleResize).toHaveBeenCalledWith(120, 40)
    expect(refresh).toHaveBeenCalledWith(0, 39)
    // Dpr refresh must precede the resize that rebuilds the backing store.
    expect(handleDevicePixelRatioChange.mock.invocationCallOrder[0]!).toBeLessThan(
      handleResize.mock.invocationCallOrder[0]!
    )
  })

  it('repairs the opposite direction (dpr-1 backing upscaled on retina)', () => {
    const { pane, handleResize } = makePane({
      backingWidth: 1080,
      backingHeight: 600,
      cssWidth: 1080,
      cssHeight: 600,
      dpr: 2,
      cellWidth: 18,
      cellHeight: 30
    })
    expect(repairPaneWebglCanvasBackingMismatch(pane)).toBe(true)
    expect(handleResize).toHaveBeenCalledTimes(1)
  })

  it('repairs a backing left behind by a hidden-time layout change, with no dpr change', () => {
    // The reveal bug: a sidebar collapse behind display:none refits the grid to
    // 92 cols while xterm's paused render service still holds the 159-col
    // canvas, so the compositor rescales the old surface into the new box.
    const { pane, handleResize, refresh } = makePane({
      backingWidth: 1272,
      backingHeight: 1040,
      cssWidth: 1272,
      cssHeight: 1040,
      dpr: 1,
      cols: 92,
      rows: 65,
      cellWidth: 8,
      cellHeight: 16
    })
    expect(repairPaneWebglCanvasBackingMismatch(pane)).toBe(true)
    expect(handleResize).toHaveBeenCalledWith(92, 65)
    expect(refresh).toHaveBeenCalledWith(0, 64)
  })

  it('drives the repaint through a paused render service instead of a swallowed refresh', () => {
    // Reveal usually runs before xterm's IntersectionObserver catches up; a
    // plain refresh would be dropped and leave the resized canvas blank.
    const { pane, refresh, refreshRows } = makePane({
      backingWidth: 1272,
      backingHeight: 1040,
      dpr: 1,
      cols: 92,
      rows: 65,
      cellWidth: 8,
      cellHeight: 16,
      paused: true
    })
    expect(repairPaneWebglCanvasBackingMismatch(pane)).toBe(true)
    expect(refreshRows).toHaveBeenCalledWith(0, 64, true)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('is a no-op when the backing matches the current grid and css box', () => {
    const { pane, handleResize, refresh } = makePane({
      backingWidth: 2160,
      backingHeight: 1200,
      dpr: 2,
      cols: 120,
      rows: 40,
      cellWidth: 18,
      cellHeight: 30
    })
    expect(repairPaneWebglCanvasBackingMismatch(pane)).toBe(false)
    expect(handleResize).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('tolerates sub-pixel rounding without churning', () => {
    // The css round trip can land one device pixel away from the grid product.
    const { pane, handleResize } = makePane({
      backingWidth: 2161,
      backingHeight: 1200,
      dpr: 2,
      cols: 120,
      rows: 40,
      cellWidth: 18,
      cellHeight: 30
    })
    expect(repairPaneWebglCanvasBackingMismatch(pane)).toBe(false)
    expect(handleResize).not.toHaveBeenCalled()
  })

  it('tolerates the larger device-pixel round trip on high-dpr displays', () => {
    const { pane, handleResize } = makePane({
      backingWidth: 2162,
      backingHeight: 1200,
      dpr: 4,
      cols: 120,
      rows: 40,
      cellWidth: 18,
      cellHeight: 30
    })
    expect(repairPaneWebglCanvasBackingMismatch(pane)).toBe(false)
    expect(handleResize).not.toHaveBeenCalled()
  })

  it('tolerates the device-pixel-content-box write-back at fractional dpr', () => {
    // xterm's own observer parks the compositor's rounding of the css box in
    // canvas.width while `dimensions.device.canvas` keeps the exact cell
    // multiple, so a healthy pane at 150 % scaling sits ~2 device px off the
    // grid product. Firing here would refit and repaint on every fit forever.
    const { pane, handleResize, refreshRows } = makePane({
      backingWidth: 2162,
      backingHeight: 1200,
      cssWidth: 1441,
      cssHeight: 800,
      dpr: 1.5,
      cols: 120,
      rows: 40,
      cellWidth: 18,
      cellHeight: 30
    })
    expect(repairPaneWebglCanvasBackingMismatch(pane)).toBe(false)
    expect(handleResize).not.toHaveBeenCalled()
    expect(refreshRows).not.toHaveBeenCalled()
  })

  it('still repairs a real drift at fractional dpr', () => {
    // Same 150 % display, but the backing is a whole stale grid behind — orders
    // of magnitude past the write-back tolerance above.
    const { pane, handleResize } = makePane({
      backingWidth: 1272,
      backingHeight: 1200,
      cssWidth: 848,
      cssHeight: 800,
      dpr: 1.5,
      cols: 120,
      rows: 40,
      cellWidth: 18,
      cellHeight: 30
    })
    expect(repairPaneWebglCanvasBackingMismatch(pane)).toBe(true)
    expect(handleResize).toHaveBeenCalledWith(120, 40)
  })

  it('repairs when only the canvas height has stale backing', () => {
    const { pane, handleResize } = makePane({
      backingWidth: 2160,
      backingHeight: 600,
      dpr: 2,
      cols: 120,
      rows: 40,
      cellWidth: 18,
      cellHeight: 30
    })
    expect(repairPaneWebglCanvasBackingMismatch(pane)).toBe(true)
    expect(handleResize).toHaveBeenCalledTimes(1)
  })

  it('falls back to the renderer device canvas when cell metrics are unavailable', () => {
    const { pane, handleResize } = makePane({
      backingWidth: 2160,
      backingHeight: 1200,
      cssWidth: 1080,
      cssHeight: 600,
      dpr: 1,
      deviceCanvasWidth: 1080,
      deviceCanvasHeight: 600
    })
    expect(repairPaneWebglCanvasBackingMismatch(pane)).toBe(true)
    expect(handleResize).toHaveBeenCalledTimes(1)
  })

  it('skips a hidden or unmeasurable pane so its parked backing is left alone', () => {
    const zeroBox = makePane({
      backingWidth: 1272,
      backingHeight: 1040,
      dpr: 1,
      cols: 92,
      rows: 65,
      cellWidth: 8,
      cellHeight: 16,
      paneBox: { width: 0, height: 0 }
    })
    expect(repairPaneWebglCanvasBackingMismatch(zeroBox.pane)).toBe(false)
    expect(zeroBox.handleResize).not.toHaveBeenCalled()

    const unmeasurable = makePane({
      backingWidth: 1272,
      backingHeight: 1040,
      dpr: 1,
      cols: 92,
      rows: 65,
      cellWidth: 8,
      cellHeight: 16,
      paneBox: null
    })
    expect(repairPaneWebglCanvasBackingMismatch(unmeasurable.pane)).toBe(false)
    expect(unmeasurable.handleResize).not.toHaveBeenCalled()
  })

  it('skips a renderer that cannot recompute its dimensions yet', () => {
    // With no measured char size xterm's `_updateDimensions` bails, so the
    // resize would re-apply the same stale numbers — an unfixable mismatch that
    // would otherwise churn a full resize plus repaint on every fit.
    const { pane, handleResize, refreshRows } = makePane({
      backingWidth: 1272,
      backingHeight: 1040,
      dpr: 1,
      cols: 92,
      rows: 65,
      cellWidth: 8,
      cellHeight: 16,
      charSizeValid: false
    })
    expect(repairPaneWebglCanvasBackingMismatch(pane)).toBe(false)
    expect(handleResize).not.toHaveBeenCalled()
    expect(refreshRows).not.toHaveBeenCalled()
  })

  it('skips detached, dimensionless, and renderer-less panes', () => {
    const detached = makePane({
      backingWidth: 2160,
      cssWidth: 1080,
      dpr: 1,
      cellWidth: 9,
      cellHeight: 15,
      connected: false
    })
    expect(repairPaneWebglCanvasBackingMismatch(detached.pane)).toBe(false)

    const noExpectation = makePane({ backingWidth: 2160, dpr: 1, cssWidth: 0, cssHeight: 0 })
    expect(repairPaneWebglCanvasBackingMismatch(noExpectation.pane)).toBe(false)

    const noRenderer = makePane({
      backingWidth: 2160,
      cssWidth: 1080,
      dpr: 1,
      hasRenderer: false
    })
    expect(repairPaneWebglCanvasBackingMismatch(noRenderer.pane)).toBe(false)
  })

  it('reports failure without throwing when the repair path throws mid-teardown', () => {
    const { pane, handleResize } = makePane({
      backingWidth: 2160,
      backingHeight: 1200,
      cssWidth: 1080,
      cssHeight: 600,
      dpr: 1,
      cellWidth: 9,
      cellHeight: 15
    })
    handleResize.mockImplementation(() => {
      throw new Error('disposed')
    })
    expect(repairPaneWebglCanvasBackingMismatch(pane)).toBe(false)
  })
})
