// The application menu.
//
// The shell used to call removeMenu(), which left the app with no shortcuts at
// all — no Cmd+T, no Cmd+W, no Cmd+,. Every item here routes to a handler the
// web UI already has; the menu adds keyboard reach, not new behaviour.
"use strict";

const { Menu, shell, app } = require("electron");

const REPO = "https://github.com/bhavesh78patil/Devtil";
const isMac = process.platform === "darwin";

/** send tells the focused window which menu action fired. */
function build(send) {
  const item = (label, accelerator, action, extra = {}) => ({
    label, accelerator, click: () => send(action), ...extra,
  });

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        item("Settings…", "Cmd+,", "settings"),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : []),
    {
      label: "&File",
      submenu: [
        item("New Tab", "CmdOrCtrl+T", "new-tab"),
        item("New Workspace", "CmdOrCtrl+Shift+N", "new-workspace"),
        { type: "separator" },
        // Close Tab deliberately shadows the usual Cmd+W "close window":
        // in a tabbed workbench, closing the whole window by reflex loses
        // your place, and the window still closes from Cmd+Shift+W.
        item("Close Tab", "CmdOrCtrl+W", "close-tab"),
        { label: "Close Window", accelerator: "CmdOrCtrl+Shift+W", role: "close" },
        ...(isMac ? [] : [
          { type: "separator" },
          item("Settings…", "Ctrl+,", "settings"),
          { type: "separator" },
          { role: "quit" },
        ]),
      ],
    },
    {
      label: "&Edit",
      submenu: [
        { role: "undo" }, { role: "redo" },
        { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
        { type: "separator" },
        item("Find in Tab", "CmdOrCtrl+F", "find"),
        item("Search Tabs", "CmdOrCtrl+P", "search-tabs"),
      ],
    },
    {
      label: "&View",
      submenu: [
        item("Toggle Sidebar", "CmdOrCtrl+B", "toggle-sidebar"),
        item("Toggle Theme", "CmdOrCtrl+Shift+D", "toggle-theme"),
        { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "reload" },
        // left in on purpose: this is a developer's tool, and being able to
        // open devtools on your own workbench is the point
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "&Window",
      submenu: [
        { role: "minimize" }, { role: "zoom" },
        ...(isMac ? [{ type: "separator" }, { role: "front" }] : []),
      ],
    },
    {
      label: "&Help",
      submenu: [
        { label: "Devtil on GitHub", click: () => shell.openExternal(REPO) },
        { label: "Report an Issue", click: () => shell.openExternal(REPO + "/issues/new") },
        { label: "Agent & MCP Setup", click: () => shell.openExternal(REPO + "/blob/main/AGENT_RULES.md") },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

function install(send) {
  Menu.setApplicationMenu(build(send));
}

/** The macOS dock menu — the one place you can act without a window focused. */
function dockMenu(send) {
  if (!isMac || !app.dock) return;
  app.dock.setMenu(Menu.buildFromTemplate([
    { label: "New Tab", click: () => send("new-tab") },
    { label: "New Workspace", click: () => send("new-workspace") },
  ]));
}

module.exports = { install, build, dockMenu };
