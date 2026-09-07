// Remembering where the window was.
//
// Every launch opening 1280x840 in the middle of the screen is one of those
// small things that makes an app feel like a web page someone wrapped. The
// state lives beside Devtil's own data rather than in Electron's userData, so
// deleting the Devtil data directory takes the window state with it.
"use strict";

const { app, screen } = require("electron");
const fs = require("fs");
const path = require("path");

const DEFAULTS = { width: 1280, height: 840 };
const MIN = { width: 940, height: 600 };

function stateFile() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (raw && typeof raw === "object") return raw;
  } catch {
    /* first run, or the file was corrupted — either way, defaults */
  }
  return {};
}

/**
 * Bounds to open with.
 *
 * A saved position is only honoured if it still lands on a display that
 * exists: undocking a laptop from a second monitor would otherwise reopen the
 * window somewhere you cannot reach it, and "my app vanished" is a much worse
 * bug than "my app forgot where it was".
 */
function restore() {
  const saved = read();
  const bounds = {
    width: Math.max(MIN.width, saved.width || DEFAULTS.width),
    height: Math.max(MIN.height, saved.height || DEFAULTS.height),
  };
  if (Number.isInteger(saved.x) && Number.isInteger(saved.y)) {
    if (onAVisibleDisplay({ ...bounds, x: saved.x, y: saved.y })) {
      bounds.x = saved.x;
      bounds.y = saved.y;
    }
  }
  return { bounds, maximized: !!saved.maximized, minSize: MIN };
}

// A window counts as reachable if any part of its title bar overlaps a
// display's work area — enough to drag it back into view.
function onAVisibleDisplay(b) {
  return screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return b.x < w.x + w.width && b.x + b.width > w.x &&
           b.y < w.y + w.height && b.y + 40 > w.y;
  });
}

/**
 * Persist size, position and maximised-ness. Writes are debounced because
 * resize fires continuously while dragging, and this is not worth the I/O.
 */
function track(win) {
  let timer = null;

  const writeNow = () => {
    if (win.isDestroyed()) return;
    // Record the restored size, not the maximised one, or un-maximising a
    // window that was closed maximised would snap it to full-screen bounds.
    const b = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
    try {
      fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
      fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }, null, 2));
    } catch (e) {
      console.error("devtil: could not save window state:", e.message);
    }
  };

  // Dragging fires resize continuously, so the common case is debounced.
  const saveSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(writeNow, 400);
  };
  for (const ev of ["resize", "move", "maximize", "unmaximize"]) win.on(ev, saveSoon);

  // Closing is the one moment that must not be debounced: the app quits well
  // inside 400ms, so a pending timer never fires and the window you carefully
  // positioned is forgotten. Write straight through instead.
  win.once("close", () => {
    clearTimeout(timer);
    writeNow();
  });
}

module.exports = { restore, track, onAVisibleDisplay, stateFile, MIN, DEFAULTS };
