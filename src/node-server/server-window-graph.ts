import type { Store } from '../main/persistence'
import type { RuntimeSyncWindowGraph } from '../shared/runtime-types'

export function createServerWindowGraph(store: Store): RuntimeSyncWindowGraph {
  const session = store.getWorkspaceSession()
  const tabs: RuntimeSyncWindowGraph['tabs'] = []
  const leaves: RuntimeSyncWindowGraph['leaves'] = []
  let paneRuntimeId = 1

  for (const [worktreeId, persistedTabs] of Object.entries(session.tabsByWorktree ?? {})) {
    for (const tab of persistedTabs) {
      const layout = session.terminalLayoutsByTabId?.[tab.id]
      if (!layout) {
        continue
      }
      tabs.push({
        tabId: tab.id,
        worktreeId,
        title: tab.title,
        activeLeafId: layout.activeLeafId,
        layout: layout.root
      })
      for (const [leafId, ptyId] of Object.entries(layout.ptyIdsByLeafId ?? {})) {
        leaves.push({
          tabId: tab.id,
          worktreeId,
          leafId,
          paneRuntimeId: paneRuntimeId++,
          ptyId,
          paneTitle: layout.titlesByLeafId?.[leafId] ?? null
        })
      }
    }
  }
  return { tabs, leaves }
}
