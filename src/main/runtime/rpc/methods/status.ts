import { defineMethod, type RpcMethod } from '../core'
import { getRemoteServerUpdaterSnapshot } from '../../remote-server-updater'

export const STATUS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'status.get',
    params: null,
    handler: (_params, { runtime, pairedDeviceId, clientCapabilities }) => {
      const snapshot = getRemoteServerUpdaterSnapshot(runtime.getRuntimeId(), {
        clientCapabilities
      })
      return {
        ...runtime.getStatus(),
        ...(pairedDeviceId ? { pairedDeviceId } : {}),
        appVersion: snapshot.appVersion,
        remoteUpdateSupport: snapshot.support
      }
    }
  })
]
