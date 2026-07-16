/* Devtil app shell: workspaces, tabs, tool picker, autosave. */
"use strict";

(() => {
  const { el, uid, debounce, api, getTool, tools } = Devtil;

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

  function closeTab(ws, tabId) {
    const idx = ws.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    ws.tabs.splice(idx, 1);
    if (ws.activeTabId === tabId) {
      ws.activeTabId = ws.tabs[Math.min(idx, ws.tabs.length - 1)]?.id ?? null;
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
          onclick: (e) => {
            e.stopPropagation();
            if (!confirm(`Delete workspace "${ws.name}" and its ${ws.tabs.length} tab(s)?`)) return;
            state.workspaces = state.workspaces.filter((w) => w.id !== ws.id);
            if (!state.workspaces.length) newWorkspace("Default");
            if (state.activeWorkspaceId === ws.id) state.activeWorkspaceId = state.workspaces[0].id;
            save();
            renderAll();
          },
        }),
      ]);
      item.addEventListener("click", () => {
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
        const commit = () => {
          ws.name = input.value.trim() || ws.name;
          save();
          renderAll();
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") input.blur();
          if (ev.key === "Escape") renderAll();
        });
      });
      list.append(item);
    }
  }

  function renderTabs() {
    const ws = activeWorkspace();
    const tabsBox = document.getElementById("tabs");
    tabsBox.replaceChildren();
    for (const tab of ws.tabs) {
      const tool = getTool(tab.type);
      const node = el("div", { class: "tab" + (tab.id === ws.activeTabId ? " active" : "") }, [
        el("span", { text: (tool ? tool.icon + " " : "") + tab.title }),
        el("button", {
          class: "tab-close", text: "×", title: "Close tab",
          onclick: (e) => { e.stopPropagation(); closeTab(ws, tab.id); },
        }),
      ]);
      node.addEventListener("click", () => {
        ws.activeTabId = tab.id;
        save();
        renderAll();
      });
      tabsBox.append(node);
    }
  }

  function renderTool() {
    const rootBox = document.getElementById("tool-root");
    rootBox.replaceChildren();
    const ws = activeWorkspace();
    const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
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
  document.getElementById("add-workspace").addEventListener("click", () => {
    const name = prompt("Workspace name:", "Workspace " + (state.workspaces.length + 1));
    if (name !== null) newWorkspace(name.trim() || undefined);
  });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); openPicker(); }
    if (e.key === "Escape") overlay.classList.add("hidden");
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
      state = { version: 1, workspaces: [], activeWorkspaceId: null };
      const ws = { id: uid(), name: "Default", tabs: [], activeTabId: null };
      state.workspaces.push(ws);
      state.activeWorkspaceId = ws.id;
    }
    renderAll();
  }

  boot();
})();
