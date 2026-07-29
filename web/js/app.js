/* Devtil app shell: workspaces, tabs, tool picker, autosave. */
"use strict";

(() => {
  const { el, uid, debounce, api, getTool, tools, confirmDialog, promptDialog } = Devtil;

  let state = null;

  // ---- autosave ----

  const indicator = document.getElementById("save-indicator");
  const pushState = debounce(async () => {
    try {
      await api("PUT", "/api/state", state);
      indicator.className = "saved";
      indicator.textContent = "All changes saved";
    } catch (e) {
      indicator.className = "error";
      indicator.textContent = "Save failed: " + e.message;
    }
  }, 600);

  function save() {
    indicator.className = "saving";
    indicator.textContent = "Saving…";
    pushState();
  }

  // ---- state helpers ----

  function activeWorkspace() {
    return state.workspaces.find((w) => w.id === state.activeWorkspaceId) || state.workspaces[0];
  }

  function newWorkspace(name) {
    const ws = { id: uid(), name: name || "Workspace " + (state.workspaces.length + 1), tabs: [], activeTabId: null };
    state.workspaces.push(ws);
    state.activeWorkspaceId = ws.id;
    save();
    renderAll();
    return ws;
  }

  function newTab(type) {
    const tool = getTool(type);
    if (!tool) return;
    const ws = activeWorkspace();
    const tab = { id: uid(), type, title: tool.name, data: tool.defaults() };
    ws.tabs.push(tab);
    ws.activeTabId = tab.id;
    save();
    renderAll();
  }

  // Closing a tab only hides it — the tab (and everything in it) stays in the
  // workspace and can be reopened from the sidebar's tab tree. Real deletion
  // happens only from the tree, behind a confirmation.
  function closeTab(ws, tabId) {
    const idx = ws.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    ws.tabs[idx].closed = true;
    if (ws.activeTabId === tabId) {
      const open = ws.tabs.filter((t) => !t.closed);
      const after = open.find((t) => ws.tabs.indexOf(t) > idx);
      ws.activeTabId = (after || open[open.length - 1])?.id ?? null;
    }
    save();
    renderAll();
  }

  function openTab(ws, tabId) {
    const tab = ws.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    tab.closed = false;
    ws.activeTabId = tab.id;
    save();
    renderAll();
  }

  async function deleteTab(ws, tabId) {
    const idx = ws.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const tab = ws.tabs[idx];
    if (!(await Devtil.confirmDialog(`Delete tab "${tab.title}" and all its contents permanently?`, { okLabel: "Delete", danger: true }))) return;
    ws.tabs.splice(idx, 1);
    if (ws.activeTabId === tabId) {
      ws.activeTabId = ws.tabs.find((t) => !t.closed)?.id ?? null;
    }
    save();
    renderAll();
  }

  // ---- rendering ----

  function renderSidebar() {
    const list = document.getElementById("workspace-list");
    list.replaceChildren();
    for (const ws of state.workspaces) {
      const nameSpan = el("span", { class: "ws-name", text: ws.name, title: "Double-click to rename" });
      const item = el("li", { class: ws.id === state.activeWorkspaceId ? "active" : "" }, [
        nameSpan,
        el("button", {
          class: "icon-btn ws-del", text: "×", title: "Delete workspace",
          onclick: async (e) => {
            e.stopPropagation();
            if (!(await confirmDialog(`Delete workspace "${ws.name}" and its ${ws.tabs.length} tab(s)?`, { okLabel: "Delete", danger: true }))) return;
            state.workspaces = state.workspaces.filter((w) => w.id !== ws.id);
            if (!state.workspaces.length) newWorkspace("Default");
            if (state.activeWorkspaceId === ws.id) state.activeWorkspaceId = state.workspaces[0].id;
            save();
            renderAll();
          },
        }),
      ]);
      item.addEventListener("click", () => {
        if (state.activeWorkspaceId === ws.id) return; // keep DOM stable so dblclick-rename works
        state.activeWorkspaceId = ws.id;
        save();
        renderAll();
      });
      nameSpan.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const input = el("input", { type: "text", value: ws.name });
        nameSpan.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (apply) => {
          if (done) return; // renderAll blurs the input — don't run twice
          done = true;
          if (apply && input.value.trim()) {
            ws.name = input.value.trim();
            save();
          }
          renderAll();
        };
        input.addEventListener("blur", () => finish(true));
        input.addEventListener("keydown", (ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter") finish(true);
          if (ev.key === "Escape") finish(false);
        });
        input.addEventListener("click", (ev) => ev.stopPropagation());
      });
      // tab tree: every tab (open and closed) with its sub-tabs, under the
      // active workspace — open on click, rename, or delete permanently
      if (ws.id === state.activeWorkspaceId && ws.tabs.length) item.append(buildTabTree(ws));
      list.append(item);
    }
  }

  function buildTabTree(ws) {
    const tree = el("div", { class: "tab-tree" });
    for (const tab of ws.tabs) {
      const tool = getTool(tab.type);
      const title = el("span", {
        class: "tt-title",
        text: (tool ? tool.icon + " " : "") + tab.title,
        title: "Click to open · double-click to rename",
      });
      const startRename = () => {
        const input = el("input", { type: "text", class: "tab-rename", value: tab.title });
        title.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (apply) => {
          if (done) return;
          done = true;
          if (apply && input.value.trim()) {
            tab.title = input.value.trim();
            save();
          }
          renderAll();
        };
        input.addEventListener("blur", () => finish(true));
        input.addEventListener("keydown", (ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter") finish(true);
          if (ev.key === "Escape") finish(false);
        });
        input.addEventListener("click", (ev) => ev.stopPropagation());
      };
      const row = el("div", {
        class: "tt-row" + (tab.id === ws.activeTabId && !tab.closed ? " active" : "") + (tab.closed ? " closed" : ""),
      }, [
        title,
        tab.closed ? el("span", { class: "tt-badge", text: "closed" }) : null,
        el("button", { class: "icon-btn", text: "✎", title: "Rename tab", onclick: (e) => { e.stopPropagation(); startRename(); } }),
        el("button", { class: "icon-btn", text: "×", title: "Delete tab permanently", onclick: (e) => { e.stopPropagation(); deleteTab(ws, tab.id); } }),
      ]);
      row.addEventListener("click", (e) => { e.stopPropagation(); openTab(ws, tab.id); });
      title.addEventListener("dblclick", (e) => { e.stopPropagation(); startRename(); });
      tree.append(row);

      const subs = tool && tool.subTabs ? (tool.subTabs(tab.data || {}) || []) : [];
      for (const s of subs) {
        const srow = el("div", { class: "tt-row tt-sub" }, [
          el("span", { class: "tt-title", text: s.label, title: "Click to open" }),
          el("button", {
            class: "icon-btn", text: "×", title: "Delete permanently",
            onclick: async (e) => {
              e.stopPropagation();
              if (!(await confirmDialog(`Delete "${s.label}"?`, { okLabel: "Delete", danger: true }))) return;
              s.remove();
              save();
              renderAll();
            },
          }),
        ]);
        srow.addEventListener("click", (e) => { e.stopPropagation(); s.select(); openTab(ws, tab.id); });
        tree.append(srow);
      }
    }
    return tree;
  }

  function renderTabs() {
    const ws = activeWorkspace();
    const tabsBox = document.getElementById("tabs");
    tabsBox.replaceChildren();
    for (const tab of ws.tabs.filter((t) => !t.closed)) {
      const tool = getTool(tab.type);
      const titleSpan = el("span", {
        text: (tool ? tool.icon + " " : "") + tab.title,
        title: "Double-click to rename",
      });
      const node = el("div", { class: "tab" + (tab.id === ws.activeTabId ? " active" : "") }, [
        titleSpan,
        el("button", {
          class: "tab-close", text: "×", title: "Close tab",
          onclick: (e) => { e.stopPropagation(); closeTab(ws, tab.id); },
        }),
      ]);
      node.addEventListener("click", () => {
        if (ws.activeTabId === tab.id) return; // keep DOM stable so dblclick-rename works
        ws.activeTabId = tab.id;
        save();
        renderAll();
      });
      titleSpan.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const input = el("input", { type: "text", class: "tab-rename", value: tab.title });
        titleSpan.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (apply) => {
          if (done) return; // renderAll blurs the input — don't run twice
          done = true;
          if (apply && input.value.trim()) {
            tab.title = input.value.trim();
            save();
          }
          renderAll();
        };
        input.addEventListener("blur", () => finish(true));
        input.addEventListener("keydown", (ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter") finish(true);
          if (ev.key === "Escape") finish(false);
        });
        input.addEventListener("click", (ev) => ev.stopPropagation());
      });
      tabsBox.append(node);
    }
  }

  function renderTool() {
    const rootBox = document.getElementById("tool-root");
    rootBox.replaceChildren();
    const ws = activeWorkspace();
    const tab = ws.tabs.find((t) => t.id === ws.activeTabId && !t.closed);
    if (!tab) {
      rootBox.append(el("div", { class: "empty-hint" }, [
        el("div", { class: "big", text: "🧰" }),
        el("div", { text: "No tabs open in this workspace." }),
        el("button", { class: "btn primary", text: "+ New tab", onclick: openPicker }),
      ]));
      return;
    }
    const tool = getTool(tab.type);
    const container = el("div", { class: "tool" });
    rootBox.append(container);
    if (!tool) {
      container.append(el("div", { class: "status-line err", text: `Unknown tool type "${tab.type}"` }));
      return;
    }
    if (!tab.data) tab.data = tool.defaults();
    tool.render(container, tab, { save });
  }

  function renderAll() {
    renderSidebar();
    renderTabs();
    renderTool();
    // let tools free the sessions of any tab that is closed or deleted
    // (closed tabs keep their data, but live resources — PTYs, tail loops —
    // are released after the grace period; reopening reconnects)
    const liveTabIds = new Set();
    for (const w of state.workspaces) for (const t of w.tabs) if (!t.closed) liveTabIds.add(t.id);
    Devtil.sweepSessions(liveTabIds);
  }

  // ---- tool picker ----

  const overlay = document.getElementById("picker-overlay");

  function openPicker() {
    const grid = document.getElementById("picker-grid");
    grid.replaceChildren(...tools.map((t) =>
      el("button", { class: "picker-card", onclick: () => { overlay.classList.add("hidden"); newTab(t.type); } }, [
        el("div", { class: "pc-icon", text: t.icon }),
        el("div", { class: "pc-name", text: t.name }),
        el("div", { class: "pc-desc", text: t.desc }),
      ])
    ));
    overlay.classList.remove("hidden");
  }

  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.add("hidden"); });
  document.getElementById("picker-close").addEventListener("click", () => overlay.classList.add("hidden"));
  document.getElementById("add-tab").addEventListener("click", openPicker);
  document.getElementById("add-workspace").addEventListener("click", async () => {
    const name = await promptDialog("Workspace name:", "Workspace " + (state.workspaces.length + 1));
    if (name !== null) newWorkspace(name.trim() || undefined);
  });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); openPicker(); }
    if (e.key === "Escape") overlay.classList.add("hidden");
  });

  // ---- sidebar collapse ----

  const navToggle = document.getElementById("nav-toggle");

  function applyNav() {
    document.getElementById("app").classList.toggle("nav-collapsed", !!state.sidebarCollapsed);
  }

  navToggle.addEventListener("click", () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    applyNav();
    save();
  });

  // ---- theme ----

  const themeSelect = document.getElementById("theme-select");

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
    themeSelect.value = theme === "dark" ? "dark" : "light";
  }

  themeSelect.addEventListener("change", () => {
    state.theme = themeSelect.value;
    applyTheme(state.theme);
    save();
  });

  // ---- report UI errors into the backend log (best effort) ----

  function reportClientError(message) {
    try {
      fetch("/api/logs/client", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      }).catch(() => {});
    } catch { /* never let logging break the app */ }
  }
  window.addEventListener("error", (e) => {
    reportClientError(`${e.message} at ${e.filename}:${e.lineno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    reportClientError("unhandled rejection: " + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
  });

  // ---- boot ----

  async function boot() {
    let loaded = {};
    try {
      loaded = await api("GET", "/api/state");
    } catch {
      /* first run or backend hiccup — start fresh */
    }
    if (loaded && Array.isArray(loaded.workspaces) && loaded.workspaces.length) {
      state = loaded;
    } else {
      state = { version: 1, theme: "light", workspaces: [], activeWorkspaceId: null };
      const ws = { id: uid(), name: "Default", tabs: [], activeTabId: null };
      state.workspaces.push(ws);
      state.activeWorkspaceId = ws.id;
    }
    applyTheme(state.theme || "light");
    applyNav();
    renderAll();
  }

  boot();
})();
