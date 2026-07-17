// Devtil desktop shell: spawns the Go backend on a free port and opens the
// UI in a native window. All features live in the Go binary + web UI, so the
// browser mode (`devtil` alone) and this app stay identical.
"use strict";

const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const PORT = 8347;
let backend = null;

function findBinary() {
  const name = process.platform === "win32" ? "devtil.exe" : "devtil";
  const candidates = [
    path.join(process.resourcesPath || "", "bin", name), // packaged app
    path.join(__dirname, "..", "bin", name),             // repo dev mode (make build)
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function waitForServer(url, attempts = 50) {
  return new Promise((resolve, reject) => {
    const tryOnce = (left) => {
      http.get(url + "/api/health", () => resolve())
        .on("error", () => {
          if (left <= 0) return reject(new Error("backend did not start"));
          setTimeout(() => tryOnce(left - 1), 200);
        });
    };
    tryOnce(attempts);
  });
}

async function createWindow() {
  const url = `http://127.0.0.1:${PORT}`;
  const bin = findBinary();
  if (bin) {
    backend = spawn(bin, ["-port", String(PORT), "-no-browser"], { stdio: "inherit" });
  }
  // If no binary was found, assume a dev server is already running on PORT.
  await waitForServer(url);

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: "Devtil",
    backgroundColor: "#f4f5f8",
    webPreferences: { contextIsolation: true },
  });
  win.removeMenu?.();
  win.loadURL(url);
  // external links (e.g. from notes) go to the real browser, not the app window
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });
}

app.whenReady().then(createWindow).catch((err) => {
  console.error(err);
  app.quit();
});

app.on("window-all-closed", () => app.quit());
app.on("quit", () => backend?.kill());
