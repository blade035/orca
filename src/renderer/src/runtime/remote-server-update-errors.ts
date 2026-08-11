import { translate } from '@/i18n/i18n'

export function remoteServerUpdateErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  switch (message) {
    case 'remote_update_manual_required':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.manualRequired',
        'This server must be updated manually through its service manager.'
      )
    case 'remote_update_not_available':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.notAvailable',
        'The server no longer reports an available update. Check again.'
      )
    case 'remote_update_not_downloaded':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.notDownloaded',
        'The server update has not finished downloading.'
      )
    case 'method_not_found':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.legacyServer',
        'Update this server manually once to enable remote updates.'
      )
    case 'remote_update_updater_timeout':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.updaterTimeout',
        'Timed out waiting for the server updater.'
      )
    case 'remote_update_requested_version_unavailable':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.requestedVersionUnavailable',
        'The server updater did not offer the requested Orca version.'
      )
    case 'remote_update_status_unavailable':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.updateUnavailable',
        'The server did not report an available update.'
      )
    case 'remote_update_download_incomplete':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.downloadIncomplete',
        'The server update did not finish downloading.'
      )
    case 'remote_update_reconnect_timeout':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.reconnectTimeout',
        'The server did not reconnect on the updated version.'
      )
    case 'remote_update_client_upgrade_required':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.clientUpgradeRequired',
        'Update this Orca client before remotely updating the server.'
      )
    case 'remote_update_client_identity_required':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.clientIdentityRequired',
        'Reconnect or pair this Orca client again before remotely updating the server.'
      )
    case 'remote_update_activation_pending':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.activationPending',
        'Another paired client is already starting an update. Wait for it to finish, then check again.'
      )
    case 'npm_update_supervisor_relaunch_required':
    case 'npm_update_daemon_relaunch_required':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.fullRelaunchRequired',
        'This update needs a full server relaunch. On the server, press Ctrl+C and rerun the same npx @stablyai/orca@latest or @rc command.'
      )
    case 'npm_update_network_failed':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.networkFailed',
        'The server could not reach the npm registry. Check its network connection and retry.'
      )
    case 'npm_update_registry_auth_failed':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.registryAuthFailed',
        'The npm registry rejected the server. Check registry access and authentication.'
      )
    case 'npm_update_disk_full':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.diskFull',
        'The server does not have enough disk space to install this update.'
      )
    case 'npm_update_permission_denied':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.permissionDenied',
        'The server cannot write its update files. Check the Orca server profile permissions.'
      )
    case 'npm_update_native_load_failed':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.nativeLoadFailed',
        'This Orca build is not compatible with the server operating system or native runtime.'
      )
    case 'npm_update_package_incomplete':
    case 'npm_update_package_identity_mismatch':
    case 'npm_update_preflight_invalid':
    case 'npm_update_preflight_failed':
    case 'npm_update_preflight_not_ready':
    case 'npm_update_preflight_version_mismatch':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.packageInvalid',
        'The downloaded Orca package failed validation. Retry after a corrected release is published.'
      )
    case 'npm_update_registry_check_failed':
    case 'npm_update_registry_version_invalid':
    case 'npm_update_registry_version_mismatch':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.registryFailed',
        'The server could not verify the requested Orca version in the npm registry. Retry later.'
      )
    case 'npm_update_install_failed':
    case 'npm_update_publish_incomplete':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.installFailed',
        'The server could not install the downloaded Orca package. Its current version is still running.'
      )
    case 'npm_process_timeout':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.operationTimeout',
        'The server update operation timed out. Its current version is still running; retry later.'
      )
    case 'npm_update_acknowledgement_timeout':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.acknowledgementTimeout',
        'The server did not receive the client update acknowledgement. Retry the update.'
      )
    case 'npm_update_supervisor_unavailable':
    case 'npm_update_supervisor_interrupted':
    case 'npm_update_state_write_failed':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.supervisorFailed',
        'The server could not safely switch versions. Its existing terminals remain available; retry or relaunch the server.'
      )
    case 'npm_update_candidate_missing':
    case 'npm_update_candidate_start_failed':
    case 'npm_update_worker_acknowledgement_timeout':
    case 'npm_update_worker_exited_during_commit':
    case 'npm_update_worker_exited_before_acknowledgement':
    case 'npm_update_worker_ipc_unavailable':
    case 'npm_update_worker_exited_before_ready':
    case 'npm_update_worker_protocol_mismatch':
    case 'npm_update_worker_ready_timeout':
    case 'npm_update_worker_version_mismatch':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.replacementFailed',
        'The replacement server did not become ready, so Orca restored the previous version. Retry or relaunch the server.'
      )
    case 'npm_update_source_version_mismatch':
    case 'npm_update_stale_runtime':
    case 'npm_update_target_not_newer':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.serverChanged',
        'The server changed while the update was starting. Check for updates again.'
      )
    case 'npm_update_failed':
      return translate(
        'auto.runtime.remoteServerUpdateErrors.failed',
        'The server update failed safely. Its current version and terminals remain available.'
      )
    default:
      return message
  }
}
