// The only bridge between the Devtil UI and the desktop shell.
//
// The renderer talks to a backend that runs SSH, kubectl and SQL, so its reach
// into Node is kept to exactly what the window chrome and the menu need:
// nothing here can read a file, spawn a process, or reach the network.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("devtilDesktop", {
  // Marks the UI as running inside the app rather than a browser tab. Every
  // desktop-only style is gated on this, so browser mode is untouched.
  platform: process.platform,

  /** Menu items and accelerators arrive here as ("new-tab", "settings", …). */
  onMenu(handler) {
    ipcRenderer.on("menu", (_event, action) => handler(action));
  },

  /**
   * The UI's theme choice, so the shell can match the native window
   * background and title-bar symbols. Sent on load and on every change —
   * otherwise a dark UI sits inside a light window frame.
   */
  setTheme(theme) {
    ipcRenderer.send("theme", theme);
  },
});
