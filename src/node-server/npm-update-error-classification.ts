export function classifyNpmCommandFailure(stderr: string, phase: 'install' | 'registry'): string {
  if (/\b(?:EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|ETIMEDOUT)\b/i.test(stderr)) {
    return 'npm_update_network_failed'
  }
  if (/\b(?:E401|E403|ENEEDAUTH)\b/i.test(stderr)) {
    return 'npm_update_registry_auth_failed'
  }
  if (/\bENOSPC\b/i.test(stderr)) {
    return 'npm_update_disk_full'
  }
  if (/\b(?:EACCES|EPERM)\b/i.test(stderr)) {
    return 'npm_update_permission_denied'
  }
  return phase === 'registry' ? 'npm_update_registry_check_failed' : 'npm_update_install_failed'
}

export function classifyNpmPreflightFailure(stderr: string): string {
  if (/npm_preflight_version_mismatch/.test(stderr)) {
    return 'npm_update_preflight_version_mismatch'
  }
  if (/npm_preflight_package_identity_mismatch/.test(stderr)) {
    return 'npm_update_package_identity_mismatch'
  }
  if (/npm_preflight_package_incomplete|MODULE_NOT_FOUND|Cannot find module/i.test(stderr)) {
    return 'npm_update_package_incomplete'
  }
  if (
    /ERR_DLOPEN_FAILED|GLIBC|invalid ELF|did not self-register|specified module could not be found/i.test(
      stderr
    )
  ) {
    return 'npm_update_native_load_failed'
  }
  return 'npm_update_preflight_failed'
}
