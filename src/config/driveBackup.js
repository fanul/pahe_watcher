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

export function parseOauthCredentials(jsonOrText) {
  if (!jsonOrText) return null;
  try {
    const parsed = typeof jsonOrText === 'string' ? JSON.parse(jsonOrText) : jsonOrText;
    const creds = parsed.web || parsed.installed || parsed;
    const clientId = creds.client_id || creds.clientId;
    const clientSecret = creds.client_secret || creds.clientSecret;
    if (clientId && clientSecret) {
      return { clientId, clientSecret, redirectUris: creds.redirect_uris || creds.redirectUris || [] };
    }
  } catch {
    // Ignore invalid JSON
  }
  return null;
}

export function applyDriveBackupOverrides(runtime, patch) {
  if (patch.driveBackup) {
    const rawJson = patch.driveBackup.oauthJson || patch.driveBackup.oauthJsonContent;
    if (rawJson) {
      const parsed = parseOauthCredentials(rawJson);
      if (parsed) {
        runtime.driveBackup.oauthClientId = parsed.clientId;
        runtime.driveBackup.oauthClientSecret = parsed.clientSecret;
      }
      delete patch.driveBackup.oauthJson;
      delete patch.driveBackup.oauthJsonContent;
    }
    Object.assign(runtime.driveBackup, patch.driveBackup);
  }
}

export function mergeDriveBackupOverrides(existing, patch) {
  return { ...(existing.driveBackup || {}), ...(patch.driveBackup || {}) };
}
