import { describe, expect, it, vi } from 'vitest'
import { remoteServerUpdateErrorMessage } from './remote-server-update-errors'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('remote server update errors', () => {
  it('gives the exact local recovery for a supervisor compatibility boundary', () => {
    expect(
      remoteServerUpdateErrorMessage(new Error('npm_update_supervisor_relaunch_required'))
    ).toContain('Ctrl+C')
  })

  it('explains that rollback preserved the previous server', () => {
    expect(remoteServerUpdateErrorMessage(new Error('npm_update_worker_ready_timeout'))).toContain(
      'restored the previous version'
    )
  })

  it('does not expose npm diagnostic text for classified failures', () => {
    expect(remoteServerUpdateErrorMessage(new Error('npm_update_registry_auth_failed'))).toBe(
      'The npm registry rejected the server. Check registry access and authentication.'
    )
  })

  it('explains paired-client ownership conflicts', () => {
    expect(remoteServerUpdateErrorMessage(new Error('remote_update_activation_pending'))).toContain(
      'Another paired client'
    )
    expect(
      remoteServerUpdateErrorMessage(new Error('remote_update_client_identity_required'))
    ).toContain('pair this Orca client again')
  })
})
