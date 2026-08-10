import { describe, expect, it } from 'vitest'
import type { Store } from '../main/persistence'
import { createServerWindowGraph } from './server-window-graph'

describe('createServerWindowGraph', () => {
  it('restores persisted terminal pane identities for daemon adoption', () => {
    const store = {
      getWorkspaceSession: () => ({
        tabsByWorktree: {
          'folder:workspace-1': [
            {
              id: 'tab-1',
              worktreeId: 'folder:workspace-1',
              title: 'Server terminal'
            }
          ]
        },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: 'leaf-1' },
            activeLeafId: 'leaf-1',
            ptyIdsByLeafId: { 'leaf-1': 'pty-1' },
            titlesByLeafId: { 'leaf-1': 'Agent' }
          }
        }
      })
    } as unknown as Store

    expect(createServerWindowGraph(store)).toEqual({
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'folder:workspace-1',
          title: 'Server terminal',
          activeLeafId: 'leaf-1',
          layout: { type: 'leaf', leafId: 'leaf-1' }
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'folder:workspace-1',
          leafId: 'leaf-1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'Agent'
        }
      ]
    })
  })
})
