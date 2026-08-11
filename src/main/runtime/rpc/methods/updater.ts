import { defineMethod, type RpcMethod } from '../core'
import { z } from 'zod'
import {
  checkRemoteServerUpdater,
  downloadRemoteServerUpdater,
  getRemoteServerUpdaterSnapshot,
  installRemoteServerUpdater
} from '../../remote-server-updater'

export const UPDATER_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'updater.getStatus',
    params: z
      .object({
        acknowledgementId: z.string().uuid().optional()
      })
      .optional(),
    handler: (params, { runtime, clientCapabilities, pairedDeviceId }) =>
      getRemoteServerUpdaterSnapshot(runtime.getRuntimeId(), {
        ...params,
        clientCapabilities,
        requesterId: pairedDeviceId
      })
  }),
  defineMethod({
    name: 'updater.check',
    params: z.object({
      includePrerelease: z.boolean().optional(),
      includePerfPrerelease: z.boolean().optional(),
      targetVersion: z.string().optional()
    }),
    handler: (params, { runtime }) => checkRemoteServerUpdater(runtime.getRuntimeId(), params)
  }),
  defineMethod({
    name: 'updater.download',
    params: null,
    handler: (_params, { runtime }) => downloadRemoteServerUpdater(runtime.getRuntimeId())
  }),
  defineMethod({
    name: 'updater.install',
    params: null,
    handler: (_params, { runtime, clientCapabilities, pairedDeviceId }) =>
      installRemoteServerUpdater(runtime.getRuntimeId(), clientCapabilities, pairedDeviceId)
  })
]
