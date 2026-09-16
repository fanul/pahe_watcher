export function getPublicDriveBackupConfig(runtime, driveBackup) {
  return {
    folderId: runtime.driveBackup.folderId,
    oauthClientId: runtime.driveBackup.oauthClientId,
    oauthClientSecret: runtime.driveBackup.oauthClientSecret,
    // Never expose the refresh token itself back to the client — it's a
    // durable credential (works until revoked), unlike the account
    // passwords this app already round-trips to prefill a form. "connected"
    // is all the GUI needs to know.
    connected: Boolean(runtime.driveBackup.oauthRefreshToken),
    configured: driveBackup.enabled,
  };
}

export function applyDriveBackupOverrides(runtime, patch) {
  if (patch.driveBackup) Object.assign(runtime.driveBackup, patch.driveBackup);
}

export function mergeDriveBackupOverrides(existing, patch) {
  return { ...(existing.driveBackup || {}), ...(patch.driveBackup || {}) };
}
