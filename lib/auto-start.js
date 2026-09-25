/**
 * Auto-start after an installation (RS-6238).
 *
 * The app has to come back on its own after a server reboot, so every
 * installation of a new version switches auto-start ON — also for a profile
 * where it had been switched off before. After that the user's choice holds:
 * switched off again, it stays off until the next version is installed.
 *
 * An installation is recognised by the version: `storedVersion` is the app
 * version that last started on this profile (config.db row `app_version`,
 * absent before 2.2.0). Values are the strings config.db holds ('true' /
 * 'false'), or null when the row does not exist.
 */
function autoStartOnInstall({ autoStartEnabled, storedVersion, currentVersion }) {
  const settled = autoStartEnabled !== null && autoStartEnabled !== undefined;
  if (storedVersion === currentVersion && settled) {
    return { autoStartEnabled, storedVersion, changed: false };
  }
  return { autoStartEnabled: 'true', storedVersion: currentVersion, changed: true };
}

module.exports = { autoStartOnInstall };
