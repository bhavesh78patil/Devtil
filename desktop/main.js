// Devtil desktop shell: spawns the Go backend and wraps the UI in a native
// window. Every feature still lives in the Go binary + web UI, so browser mode
// (`devtil` alone) and this app remain the same product — the shell only adds
// what a browser tab cannot give you: real window chrome, an application menu,
// remembered geometry, and the OS's own materials behind the UI.
"use strict";

const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require("electron");
const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");
const fs = require("fs");

const { initAutoUpdate } = require("./updater");
const menu = require("./menu");
const windowState = require("./state");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

// The two canvas colours from web/style.css. The window is painted with one of
// these before the UI loads, so launching never flashes white.
const CANVAS = { light: "#fffefb", dark: "#201515" };

let backend = null;
let win = null;
let theme = "light";

function findBinary() {
  const name = isWin ? "devtil.exe" : "devtil";
  return [
    path.join(process.resourcesPath || "", "bin", name), // packaged app
    path.join(__dirname, "..", "bin", name),             // repo dev mode (make build)
  ].find((p) => fs.existsSync(p));
}

/**
 * Start the backend and learn which port it actually got.
 *
 * The shell used to hardcode 8347 and, when that was taken, silently attach to
 * whatever was already listening — so opening the app while `devtil` ran in a
 * browser gave you a second window onto someone else's process. Passing
 * `-port 0` lets the OS pick a free one, and the binary already logs
 * "devtil running at <url>", so the URL is read back rather than assumed.
 */
function startBackend() {
  const bin = findBinary();
  if (!bin) {
    // no binary: assume a dev server is already up, which is how the UI is
    // iterated on without rebuilding Go every time
    return Promise.resolve(process.env.DEVTIL_URL || "http://127.0.0.1:8347");
  }
  return new Promise((resolve, reject) => {
    backend = spawn(bin, ["-port", "0", "-no-browser"], { stdio: ["ignore", "pipe", "pipe"] });

    const timer = setTimeout(() => reject(new Error("the backend did not report a URL within 15s")), 15000);
    const settle = (url) => { clearTimeout(timer); resolve(url); };

    // the startup line goes to the standard logger, which writes to stderr
    for (const stream of [backend.stdout, backend.stderr]) {
      readline.createInterface({ input: stream }).on("line", (line) => {
        process.stdout.write(line + "\n"); // keep the backend's log visible
        const m = line.match(/running at (https?:\/\/\S+?)[\s,)]/) || line.match(/running at (https?:\/\/\S+)/);
        if (m) settle(m[1]);
      });
    }
    backend.on("error", (err) => { clearTimeout(timer); reject(err); });
    backend.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the backend exited with code ${code} before it was ready`));
    });
  });
}

/** Window options that make this look like an app rather than a browser tab. */
function chrome() {
  const opts = {
    backgroundColor: CANVAS[theme],
    // the UI is drawn only once it has something to show
    show: false,
    autoHideMenuBar: !isMac,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (isMac) {
    // the app's own header becomes the title bar, with the traffic lights
    // inset over the sidebar's brand row
    opts.titleBarStyle = "hiddenInset";
    opts.trafficLightPosition = { x: 18, y: 18 };
    // the OS blurs the desktop behind the window; the UI's own surfaces sit
    // on top, so only the margins pick it up — which is the intent
    opts.vibrancy = "under-window";
    opts.visualEffectState = "active";
  } else if (isWin) {
    // Windows 11 draws its own min/max/close over the UI; Mica is ignored
    // harmlessly on Windows 10
    opts.titleBarStyle = "hidden";
    opts.titleBarOverlay = overlayColors();
    opts.backgroundMaterial = "mica";
  }
  return opts;
}

function overlayColors() {
  return {
    color: CANVAS[theme],
    symbolColor: theme === "dark" ? "#fffefb" : "#201515",
    height: 40, // matches #tabbar's min-height in web/style.css
  };
}

/** Tell the focused window which menu action fired. */
const send = (action) => win && !win.isDestroyed() && win.webContents.send("menu", action);

async function createWindow() {
  let url;
  try {
    url = await startBackend();
  } catch (err) {
    dialog.showErrorBox("Devtil could not start",
      `${err.message}\n\nThe app could not launch its backend, so there is nothing to show. ` +
      `Running "devtil" from a terminal will usually say why.`);
    app.quit();
    return;
  }

  const { bounds, maximized, minSize } = windowState.restore();
  win = new BrowserWindow({
    ...bounds,
    minWidth: minSize.width,
    minHeight: minSize.height,
    title: "Devtil",
    ...chrome(),
  });
  if (maximized) win.maximize();
  windowState.track(win);

  // paint first, then reveal — no white flash while the UI boots
  win.once("ready-to-show", () => win.show());

  win.loadURL(url);
  // external links (e.g. from notes) go to the real browser, not the app window
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });

  menu.install(send);
  menu.dockMenu(send);

  // Check GitHub Releases for a newer version and nudge / auto-install per OS.
  initAutoUpdate();
}

// The UI owns the theme; the shell follows it so the native frame never
// disagrees with what is inside it.
ipcMain.on("theme", (_event, next) => {
  if (next !== "light" && next !== "dark") return;
  theme = next;
  nativeTheme.themeSource = next;
  if (!win || win.isDestroyed()) return;
  win.setBackgroundColor(CANVAS[theme]);
  if (isWin && win.setTitleBarOverlay) win.setTitleBarOverlay(overlayColors());
});

// One window only: launching again focuses what is already open rather than
// starting a second backend against the same state file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(createWindow).catch((err) => {
    console.error(err);
    app.quit();
  });
}

app.on("activate", () => {
  // macOS: clicking the dock icon with no windows open reopens one
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("window-all-closed", () => { if (!isMac) app.quit(); });
app.on("quit", () => backend?.kill());
