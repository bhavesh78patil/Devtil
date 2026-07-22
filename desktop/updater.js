// Auto-update for the Devtil desktop app.
//
// Uses electron-updater against the project's GitHub Releases. When the CI
// release workflow publishes a new version it also uploads the update metadata
// (latest.yml / latest-mac.yml + blockmaps); this module reads that metadata,
// compares it to the running version and nudges the user to update.
//
// Per-OS behaviour:
//   * Windows (NSIS): the update is downloaded silently in the background and
//     installed on the next restart — a true auto-update, no signing required.
//   * macOS: Squirrel.Mac can only *install* an update when the app is signed
//     with a paid Apple Developer ID (this build is only ad-hoc signed), so we
//     nudge the user and open the download page instead. Once real signing +
//     notarization is added this file will auto-install on mac too — just set
//     MAC_CAN_SELFINSTALL to true.
"use strict";

const { app, dialog, shell } = require("electron");

const OWNER = "bhavesh78patil";
const REPO = "Devtil";
const MAC_CAN_SELFINSTALL = false; // flip to true once the mac build is Developer-ID signed + notarized

function releasePageUrl(version) {
  return version
    ? `https://github.com/${OWNER}/${REPO}/releases/tag/v${version}`
    : `https://github.com/${OWNER}/${REPO}/releases/latest`;
}

function initAutoUpdate() {
  // Auto-update only makes sense for a packaged app pointed at real releases.
  if (!app.isPackaged) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    // dependency not bundled — skip quietly rather than crash the app
    return;
  }

  const isMac = process.platform === "darwin";
  const macNudgeOnly = isMac && !MAC_CAN_SELFINSTALL;
  const log = (...a) => console.log("[updater]", ...a);

  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  autoUpdater.autoDownload = !macNudgeOnly; // don't pre-download what we can't install
  autoUpdater.autoInstallOnAppQuit = true;

  let nudged = false; // avoid repeating the mac dialog on every periodic check

  autoUpdater.on("update-available", async (info) => {
    log("update available:", info.version);
    if (macNudgeOnly) {
      if (nudged) return;
      nudged = true;
      const { response } = await dialog.showMessageBox({
        type: "info",
        title: "Update available",
        message: `Devtil ${info.version} is available.`,
        detail:
          `You're on ${app.getVersion()}. Download the new version, then drag ` +
          `Devtil into your Applications folder to update.`,
        buttons: ["Download", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) shell.openExternal(releasePageUrl(info.version));
      return;
    }
    // Windows: it's already downloading in the background — just let them know.
    dialog.showMessageBox({
      type: "info",
      title: "Update available",
      message: `Devtil ${info.version} is downloading in the background.`,
      detail: "You'll be asked to restart once it's ready to install.",
      buttons: ["OK"],
      defaultId: 0,
    });
  });

  autoUpdater.on("update-downloaded", async (info) => {
    log("update downloaded:", info.version);
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Update ready",
      message: `Devtil ${info.version} is ready to install.`,
      detail: "Restart now to finish updating.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on("error", (err) => log("error:", (err && err.message) || err));

  const check = () =>
    autoUpdater
      .checkForUpdates()
      .catch((e) => log("check failed:", (e && e.message) || e));

  setTimeout(check, 8000); // shortly after launch
  setInterval(check, 6 * 60 * 60 * 1000); // and every 6 hours while running
}

module.exports = { initAutoUpdate };
