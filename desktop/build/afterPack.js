// electron-builder afterPack hook: ad-hoc code-sign the macOS app.
//
// We have no paid Apple Developer certificate, so the app can't be notarized.
// But on Apple Silicon an app with *no* signature at all is killed by the OS
// ("damaged"), so we apply an ad-hoc signature (codesign --sign -). This lets
// the app actually run once the user clears the download quarantine flag
// (xattr -dr com.apple.quarantine /Applications/Devtil.app) or right-click →
// Open. It does not remove the Gatekeeper prompt itself — only notarization
// (a paid Apple account) can do that.
"use strict";

const { execSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  try {
    execSync(`codesign --force --deep --sign - "${app}"`, { stdio: "inherit" });
    console.log("afterPack: ad-hoc signed " + app);
  } catch (e) {
    console.warn("afterPack: ad-hoc sign failed (continuing): " + e.message);
  }
};
