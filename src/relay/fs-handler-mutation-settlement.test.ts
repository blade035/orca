import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayContext } from './context'
import type { RelayDispatcher } from './dispatcher'
import { FsHandler } from './fs-handler'

type TestContext = { clientId: number; isStale: () => boolean }
type RequestHandler = (params: Record<string, unknown>, context: TestContext) => Promise<unknown>
type NotificationHandler = (params: Record<string, unknown>, context: TestContext) => void

function createDispatcher() {
  const requests = new Map<string, RequestHandler>()
  const notifications = new Map<string, NotificationHandler>()
  return {
    onRequest: (method: string, handler: RequestHandler) => requests.set(method, handler),
    onNotification: (method: string, handler: NotificationHandler) =>
      notifications.set(method, handler),
    onClientDetached: vi.fn(),
    notify: vi.fn(),
    notifyClient: vi.fn(),
    requests,
    notifications
  }
}

describe('FsHandler mutation settlement', () => {
  const cleanupPaths: string[] = []

  afterEach(async () => {
    await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true })))
  })

  it('registers before write preflight and retains settlement until release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-fs-mutation-'))
    cleanupPaths.push(root)
    const dispatcher = createDispatcher()
    const handler = new FsHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
    const context = { clientId: 7, isStale: () => false }
    const operationId = 'setup-write-1'

    const write = dispatcher.requests.get('fs.writeFile')!(
      { filePath: join(root, 'setup.sh'), content: 'ready', operationId },
      context
    )
    const operations = (handler as unknown as { mutationOperations: Map<string, Promise<void>> })
      .mutationOperations
    expect(operations.has(`${context.clientId}:${operationId}`)).toBe(true)
    await expect(write).resolves.toEqual({ mutationTracked: true })
    await expect(
      dispatcher.requests.get('fs.awaitMutation')!({ operationId }, context)
    ).resolves.toEqual({ found: true })

    dispatcher.notifications.get('fs.releaseMutation')!({ operationId }, context)
    await expect(
      dispatcher.requests.get('fs.awaitMutation')!({ operationId }, context)
    ).resolves.toEqual({ found: false })
    handler.dispose()
  })
})
