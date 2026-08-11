import { describe, expect, it } from 'vitest'
import {
  classifyNpmCommandFailure,
  classifyNpmPreflightFailure
} from './npm-update-error-classification'

describe('npm update error classification', () => {
  it.each([
    ['npm ERR! code ENOTFOUND', 'npm_update_network_failed'],
    ['npm ERR! code E401', 'npm_update_registry_auth_failed'],
    ['npm ERR! code ENOSPC', 'npm_update_disk_full'],
    ['npm ERR! code EACCES', 'npm_update_permission_denied']
  ])('redacts npm failure %s', (stderr, expected) => {
    expect(classifyNpmCommandFailure(stderr, 'install')).toBe(expected)
  })

  it.each([
    ['Error: npm_preflight_version_mismatch', 'npm_update_preflight_version_mismatch'],
    ['Error: Cannot find module node-pty', 'npm_update_package_incomplete'],
    ['Error [ERR_DLOPEN_FAILED]: GLIBC_2.32 not found', 'npm_update_native_load_failed']
  ])('classifies preflight failure %s', (stderr, expected) => {
    expect(classifyNpmPreflightFailure(stderr)).toBe(expected)
  })

  it('never returns raw stderr', () => {
    expect(classifyNpmCommandFailure('secret-token-value', 'registry')).toBe(
      'npm_update_registry_check_failed'
    )
  })
})
