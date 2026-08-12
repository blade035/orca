import process from 'node:process'
import { pollUntil } from '../../config/scripts/windows-apphang-repro/repro-timing.mjs'
import { FIXTURE_MARKER } from './terminal-reveal-raster-fixture.mjs'

async function elementCenter(page, selector) {
  return page.evaluate((selector) => {
    const element = document.querySelector(selector)
    if (!(element instanceof HTMLElement)) {
      return null
    }
    element.scrollIntoView({ block: 'center', inline: 'nearest' })
    const surface = element.querySelector('[data-worktree-card-surface="true"]') ?? element
    const rect = surface.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : null
  }, selector)
}

async function clickElementCenter(page, selector, label) {
  const point = await elementCenter(page, selector)
  if (!point) {
    throw new Error(`Could not locate ${label}`)
  }
  await page.mouse.click(point.x, point.y)
}

export async function activateWorktree(page, worktreeId) {
  const selector = `[data-worktree-id="${worktreeId.replaceAll('"', '\\"')}"]`
  const point = await elementCenter(page, selector)
  // A collapsed sidebar removes the worktree cards; the store action is the same
  // one the card's click handler dispatches.
  await (point
    ? page.mouse.click(point.x, point.y)
    : page.evaluate((id) => window.__store?.getState().setActiveWorktree?.(id), worktreeId))
  await pollUntil(
    `active worktree ${worktreeId}`,
    () =>
      page.evaluate((id) => {
        const state = window.__store?.getState()
        return state?.activeWorktreeId === id && state.activeTabType === 'terminal'
      }, worktreeId),
    Boolean,
    30_000,
    10
  )
}

export async function activateTab(page, tabId) {
  await clickElementCenter(page, `[data-tab-id="${tabId.replaceAll('"', '\\"')}"]`, `tab ${tabId}`)
  await pollUntil(
    `active tab ${tabId}`,
    () => page.evaluate((id) => window.__store?.getState().activeTabId === id, tabId),
    Boolean,
    20_000,
    10
  )
}

export async function waitForTabManager(page, tabId) {
  return pollUntil(
    `terminal manager ${tabId}`,
    () =>
      page.evaluate((id) => {
        const manager = window.__paneManagers?.get(id)
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
        return Boolean(pane?.container?.dataset?.ptyId)
      }, tabId),
    Boolean,
    30_000,
    20
  )
}

export async function activeTabId(page) {
  return page.evaluate(() => window.__store?.getState().activeTabId ?? null)
}

export async function runStaticFixture(page, tabId, scriptPath) {
  await waitForTabManager(page, tabId)
  const commandPath = process.platform === 'win32' ? scriptPath.replaceAll('\\', '/') : scriptPath
  const command = `node "${commandPath.replaceAll('"', '\\"')}"`
  await page.evaluate(
    ({ id, command }) => {
      const manager = window.__paneManagers?.get(id)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      const ptyId = pane?.container?.dataset?.ptyId
      if (!ptyId) {
        throw new Error(`Tab ${id} has no bound PTY`)
      }
      window.api.pty.write(ptyId, `${command}\n`)
    },
    { id: tabId, command }
  )
  await pollUntil(
    'static terminal fixture output',
    () =>
      page.evaluate(
        ({ id, marker }) => {
          const manager = window.__paneManagers?.get(id)
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return pane?.serializeAddon?.serialize?.().includes(marker)
        },
        { id: tabId, marker: FIXTURE_MARKER }
      ),
    Boolean,
    20_000,
    50
  )
}

export async function injectBlankFault(page, tabId, holdMs) {
  return page.evaluate(
    ({ id, ms }) => window.__terminalRevealRasterProbe?.injectBlankFault(id, ms) ?? false,
    { id: tabId, ms: holdMs }
  )
}

export async function holdSynchronizedOutput(page, tabId) {
  return page.evaluate((id) => window.__terminalRevealRasterProbe?.holdSync(id) ?? false, tabId)
}

export async function pinProbeToActivePane(page, tabId) {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const ptyId = pane?.container?.dataset?.ptyId ?? null
    window.__terminalRevealRasterProbe?.pinPty(ptyId)
    return ptyId
  }, tabId)
}

export async function createPressureTabs(page, worktreeId, count) {
  const tabIds = []
  for (let index = 0; index < count; index += 1) {
    const tabId = await page.evaluate((id) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      const tab = store.getState().createTab(id, undefined, undefined, { activate: true })
      store.getState().setActiveTab(tab.id)
      return tab.id
    }, worktreeId)
    await waitForTabManager(page, tabId)
    tabIds.push(tabId)
  }
  return tabIds
}

export async function readTargetState(page, tabId) {
  return page.evaluate((id) => window.__terminalRevealRasterProbe?.readState(id) ?? null, tabId)
}

export async function setSidebarOpen(page, open) {
  await page.evaluate((value) => window.__store?.getState().setSidebarOpen?.(value), open)
  await settleFrames(page, 3)
}

export async function splitTabPanes(page, tabId, extraPanes) {
  const created = await page.evaluate(
    ({ id, extra }) => {
      const manager = window.__paneManagers?.get(id)
      if (!manager) {
        return 0
      }
      let added = 0
      for (let index = 0; index < extra; index += 1) {
        const pane = manager.getActivePane?.() ?? manager.getPanes?.()[0]
        if (!pane) {
          break
        }
        manager.splitPane(pane.id, index % 2 === 0 ? 'vertical' : 'horizontal')
        added += 1
      }
      return added
    },
    { id: tabId, extra: extraPanes }
  )
  await settleFrames(page, 3)
  return created
}

// Split arms leave extra panes behind, which would move every later arm's
// geometry; drop everything except the pane holding the fixture PTY.
export async function closeExtraPanes(page, tabId, keepPtyId) {
  const closed = await page.evaluate(
    ({ id, ptyId }) => {
      const manager = window.__paneManagers?.get(id)
      const panes = manager?.getPanes?.() ?? []
      if (panes.length <= 1 || !ptyId) {
        return 0
      }
      let removed = 0
      for (const pane of panes) {
        if (pane?.container?.dataset?.ptyId !== ptyId) {
          manager.closePane(pane.id)
          removed += 1
        }
      }
      return removed
    },
    { id: tabId, ptyId: keepPtyId }
  )
  if (closed > 0) {
    await settleFrames(page, 3)
  }
  return closed
}

export async function settleFrames(page, count = 2) {
  await page.evaluate(
    (frames) =>
      new Promise((resolve) => {
        let remaining = frames
        const step = () => {
          remaining -= 1
          if (remaining <= 0) {
            resolve()
            return
          }
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      }),
    Math.max(1, count)
  )
}

export async function applyDeviceMetrics(cdp, metrics) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: metrics.width,
    height: metrics.height,
    deviceScaleFactor: metrics.deviceScaleFactor,
    mobile: false
  })
}

export async function clearDeviceMetrics(cdp) {
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
}

export async function readViewport(page) {
  return page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio
  }))
}

export async function installRevealRasterProbe(page) {
  await page.evaluate(() => {
    if (window.__terminalRevealRasterProbe) {
      return
    }
    const managerIds = new WeakMap()
    const terminalIds = new WeakMap()
    const canvasIds = new WeakMap()
    let nextIdentity = 1
    const identity = (map, value) => {
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
        return null
      }
      let current = map.get(value)
      if (!current) {
        current = nextIdentity++
        map.set(value, current)
      }
      return current
    }
    const hashText = (text) => {
      let hash = 2166136261
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
      }
      return (hash >>> 0).toString(16).padStart(8, '0')
    }
    const readCanvases = (screen) =>
      screen
        ? Array.from(screen.querySelectorAll('canvas')).map((canvas) => {
            const canvasRect = canvas.getBoundingClientRect()
            const expectedWidth = Math.round(canvasRect.width * devicePixelRatio)
            const expectedHeight = Math.round(canvasRect.height * devicePixelRatio)
            return {
              identity: identity(canvasIds, canvas),
              width: canvas.width,
              height: canvas.height,
              cssWidth: canvasRect.width,
              cssHeight: canvasRect.height,
              expectedWidth,
              expectedHeight,
              // A backing store that disagrees with its css box is composited
              // by scaling the stale bitmap, which is the smeared-text shape.
              backingScaleX: canvasRect.width > 0 ? canvas.width / canvasRect.width : null,
              backingMatchesExpected:
                Math.abs(canvas.width - expectedWidth) <= 1 &&
                Math.abs(canvas.height - expectedHeight) <= 1
            }
          })
        : []
    // Splitting makes the new empty pane active, so pin the probe to the pane
    // that owns the fixture PTY instead of following focus.
    let preferredPtyId = null
    const pickPane = (manager) => {
      const panes = manager?.getPanes?.() ?? []
      const preferred = preferredPtyId
        ? panes.find((pane) => pane?.container?.dataset?.ptyId === preferredPtyId)
        : null
      return preferred ?? manager?.getActivePane?.() ?? panes[0] ?? null
    }
    const readState = (tabId) => {
      const state = window.__store?.getState()
      const manager = window.__paneManagers?.get(tabId) ?? null
      const pane = pickPane(manager)
      const terminal = pane?.terminal ?? null
      const screen = pane?.container?.querySelector?.('.xterm-screen') ?? null
      const rect = screen?.getBoundingClientRect?.() ?? null
      const style = screen ? getComputedStyle(screen) : null
      const diagnostics = manager
        ?.getRenderingDiagnostics?.()
        ?.find((entry) => entry.paneId === pane?.id)
      const lines = []
      let nonblankCells = 0
      if (terminal) {
        const buffer = terminal.buffer.active
        for (let row = 0; row < terminal.rows; row += 1) {
          const line = buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
          lines.push(line)
          nonblankCells += line.replaceAll(' ', '').length
        }
      }
      return {
        wallAt: Date.now(),
        performanceAt: performance.now(),
        tabId,
        targetActive: state?.activeTabId === tabId,
        activeWorktreeId: state?.activeWorktreeId ?? null,
        managerPresent: Boolean(manager),
        managerIdentity: identity(managerIds, manager),
        terminalIdentity: identity(terminalIds, terminal),
        paneCount: manager?.getPaneCount?.() ?? null,
        renderingSuspended: manager?.renderingSuspended ?? null,
        parked: window.__terminalParkingDebug?.parkedTabIds?.().includes(tabId) ?? null,
        parkedTabIds: window.__terminalParkingDebug?.parkedTabIds?.() ?? null,
        worktreeParkingVerdicts: window.__terminalParkingDebug?.worktreeVerdicts?.() ?? null,
        renderer: diagnostics?.hasWebgl ? 'webgl' : manager ? 'dom' : null,
        renderingDiagnostics: diagnostics ?? null,
        ptyId: pane?.container?.dataset?.ptyId ?? null,
        cols: terminal?.cols ?? null,
        rows: terminal?.rows ?? null,
        viewportY: terminal?.buffer?.active?.viewportY ?? null,
        bufferHash: terminal ? hashText(lines.join('\n')) : null,
        nonblankCells,
        screenClip:
          rect && rect.width > 0 && rect.height > 0
            ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            : null,
        dpr: devicePixelRatio,
        // Whether the fixture is actually holding DEC 2026 and whether xterm's
        // render service is latched: together they decide if a repaint paints.
        synchronizedOutput:
          terminal?._core?.coreService?.decPrivateModes?.synchronizedOutput ?? null,
        renderPaused: terminal?._core?._renderService?._isPaused ?? null,
        innerWidth,
        innerHeight,
        screenStyle: style
          ? {
              display: style.display,
              visibility: style.visibility,
              opacity: style.opacity,
              filter: style.filter,
              transform: style.transform
            }
          : null,
        canvases: readCanvases(screen)
      }
    }
    let rafId = null
    let blankFaultFiredAt = 0
    let samples = []
    let targetTabId = null
    let pump = null
    let pumpPhase = 0
    // Screencast only emits on compositor swaps, so a still terminal yields a
    // handful of frames and hides short transitions. This 4 px marker sits above
    // the terminal clip and repaints every frame to keep the sampler at vsync.
    const ensurePump = () => {
      if (!pump) {
        pump = document.createElement('div')
        pump.dataset.revealRasterPump = 'true'
        pump.style.cssText =
          'position:fixed;top:0;left:0;width:4px;height:4px;z-index:2147483647;pointer-events:none'
        document.body.append(pump)
      }
      return pump
    }
    const tick = () => {
      if (!targetTabId) {
        return
      }
      pumpPhase = (pumpPhase + 1) % 2
      ensurePump().style.background = pumpPhase ? 'rgb(255,0,0)' : 'rgb(0,0,255)'
      samples.push(readState(targetTabId))
      if (samples.length > 600) {
        samples.shift()
      }
      rafId = requestAnimationFrame(tick)
    }
    window.__terminalRevealRasterProbe = {
      readState,
      pinPty(ptyId) {
        preferredPtyId = ptyId ?? null
      },
      // Orca stops feeding the pty while a pane is hidden, so a fixture that
      // holds DEC 2026 cannot get its BSU across the reveal boundary — measured:
      // synchronizedOutput is false for the first ~200 ms of every reveal. Set
      // the mode directly on the hidden terminal to reproduce the state an agent
      // TUI is actually in when the reveal fit runs; the fixture's next ESU
      // releases it exactly as a real TUI frame flush would.
      // Fault injection, not a reproduction: replays the reverted commit's
      // timing-free blank shape (bitmap cleared, repaint swallowed, xterm's
      // recovery zeroed) so the blank-pane measurement, thresholds and plumbing
      // can be validated without recreating the race that produced it. The
      // bitmap is re-cleared for a bounded window because the reveal's WebGL
      // attach repaints shortly after the fit and would otherwise heal the
      // injected fault before a single frame could observe it.
      injectBlankFault(tabId, holdMs) {
        blankFaultFiredAt = 0
        // Armed while the pane is still hidden and fires the moment the reveal's
        // WebGL attach produces a canvas — hooking handleResize instead missed
        // the warm arms entirely, where the reveal resize lands on the DOM
        // renderer and no resize follows the attach.
        const deadline = Date.now() + 5_000
        const step = () => {
          if (Date.now() > deadline) {
            return
          }
          const service = pickPane(window.__paneManagers?.get(tabId))?.terminal?._core
            ?._renderService
          const renderer = service?._renderer?.value
          const canvas = renderer?._canvas ?? renderer?._gl?.canvas
          if (canvas?.isConnected && canvas.width > 0) {
            blankFaultFiredAt ||= Date.now()
            // Re-assigning width clears the bitmap (HTML canvas side effect).
            const width = canvas.width
            canvas.width = width
            service._isPaused = false
            service._needsFullRefresh = false
            if (Date.now() - blankFaultFiredAt >= holdMs) {
              return
            }
          }
          requestAnimationFrame(step)
        }
        step()
        return true
      },
      blankFaultFiredAt() {
        return blankFaultFiredAt
      },
      holdSync(tabId) {
        const terminal = pickPane(window.__paneManagers?.get(tabId))?.terminal
        const modes = terminal?._core?.coreService?.decPrivateModes
        if (!modes) {
          return false
        }
        modes.synchronizedOutput = true
        return true
      },
      start(tabId) {
        if (rafId !== null) {
          cancelAnimationFrame(rafId)
        }
        samples = []
        targetTabId = tabId
        tick()
      },
      stop() {
        if (rafId !== null) {
          cancelAnimationFrame(rafId)
        }
        rafId = null
        targetTabId = null
        pump?.remove()
        pump = null
        return samples
      }
    }
  })
}

// Screencast frames carry the compositor's own capture timestamp; receipt time
// adds IPC latency that would mispair a 16 ms transition with renderer state.
function frameTimestamp(params, receiptAt) {
  const timestamp = params.metadata?.timestamp
  return typeof timestamp === 'number' && timestamp > 0 ? Math.round(timestamp * 1000) : receiptAt
}

export async function captureCompositorTransition(page, tabId, captureMs, action) {
  const frames = []
  const cdp = await page.context().newCDPSession(page)
  cdp.on('Page.screencastFrame', (params) => {
    const receiptAt = Date.now()
    frames.push({
      buffer: Buffer.from(params.data, 'base64'),
      receiptAt,
      capturedAt: frameTimestamp(params, receiptAt),
      metadata: params.metadata
    })
    void cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
  })
  await page.evaluate((id) => window.__terminalRevealRasterProbe.start(id), tabId)
  await cdp.send('Page.enable').catch(() => {})
  const viewport = await readViewport(page)
  await cdp.send('Page.startScreencast', {
    format: 'png',
    everyNthFrame: 1,
    maxWidth: Math.ceil(viewport.width * viewport.dpr),
    maxHeight: Math.ceil(viewport.height * viewport.dpr)
  })
  await page.waitForTimeout(50)
  let actionAt = Date.now()
  try {
    // Arms that spend time off-screen re-stamp the action once the reveal
    // itself starts, so the hidden gap is not scored as reveal latency.
    await action({
      mark: () => {
        actionAt = Date.now()
      }
    })
    await page.waitForTimeout(captureMs)
  } finally {
    await cdp.send('Page.stopScreencast').catch(() => {})
  }
  const states = await page.evaluate(() => window.__terminalRevealRasterProbe.stop())
  await cdp.detach().catch(() => {})
  return {
    actionAt,
    captureViewport: viewport,
    frames: frames.slice(0, 400),
    states
  }
}

export async function captureStableReference(page, tabId, samples = 3) {
  const captures = []
  for (let index = 0; index < samples; index += 1) {
    // Late repairs (DPR, deferred fits) can still move geometry a few frames
    // after reveal; spacing the samples keeps them out of the reference.
    await page.waitForTimeout(200)
    await settleFrames(page, 3)
    const state = await readTargetState(page, tabId)
    const buffer = await page.screenshot()
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight
    }))
    captures.push({ state, buffer, viewport })
  }
  return captures
}

export async function waitForParkedTarget(page, tabId) {
  return pollUntil(
    `parked target ${tabId}`,
    () => readTargetState(page, tabId),
    (state) => state?.parked === true && state.managerPresent === false,
    20_000,
    50
  )
}
