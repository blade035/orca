import { parseHostAccessLink } from '../../../../shared/remote-pairing-address'
import { useAppStore } from '@/store'

export function openTerminalPairingLink(accessLink: string): boolean {
  if (!isTerminalPairingLink(accessLink)) {
    return false
  }
  const { openSettingsPage, openSettingsTarget } = useAppStore.getState()
  openSettingsTarget({
    pane: 'servers',
    repoId: null,
    intent: 'add-remote-orca-server',
    accessLink
  })
  openSettingsPage()
  return true
}

export function isTerminalPairingLink(accessLink: string): boolean {
  return parseHostAccessLink(accessLink).ok
}
