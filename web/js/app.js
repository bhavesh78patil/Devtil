/* Devtil app shell: workspaces, tabs, tool picker, autosave. */
"use strict";

(() => {
  const { el, uid, debounce, api, getTool, tools, confirmDialog, promptDialog, copyText } = Devtil;

  let state = null;
  // sidebar tab filter — a view concern, deliberately not persisted
  let tabQuery = "";

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
      const isActive = ws.id === state.activeWorkspaceId;
      // collapse the tree to get the workspace list back to one line each
      const caret = el("button", {
        class: "icon-btn ws-caret",
        text: ws.treeCollapsed ? "▸" : "▾",
        title: ws.treeCollapsed ? "Show tabs" : "Hide tabs",
        onclick: (e) => { e.stopPropagation(); ws.treeCollapsed = !ws.treeCollapsed; save(); renderSidebar(); },
      });
      const item = el("li", { class: isActive ? "active" : "" }, [
        isActive && ws.tabs.length ? caret : null,
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
      if (isActive && ws.tabs.length && !ws.treeCollapsed) item.append(buildTabTree(ws));
      list.append(item);
    }
    // a search with no hits anywhere is worth saying out loud
    if (tabQuery && !list.querySelector(".tt-row")) {
      list.append(el("li", { class: "tt-empty" }, [el("span", { text: `No tabs match “${tabQuery}”` })]));
    }
  }

  function buildTabTree(ws) {
    const tree = el("div", { class: "tab-tree" });
    const q = tabQuery.toLowerCase();
    for (const tab of ws.tabs) {
      const tool = getTool(tab.type);
      // when searching, keep a tab if it matches, or if any of its sub-tabs do
      const subsAll = tool && tool.subTabs ? (tool.subTabs(tab.data || {}, tab) || []) : [];
      const hitSubs = q ? subsAll.filter((s) => s.label.toLowerCase().includes(q)) : subsAll;
      const tabHit = !q || tab.title.toLowerCase().includes(q) || tab.type.toLowerCase().includes(q);
      if (q && !tabHit && !hitSubs.length) continue;
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

      // while searching show only the matching sub-tabs (unless the tab name
      // itself is the hit, in which case show all of them)
      const subs = q && !tabHit ? hitSubs : subsAll;
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
  // sidebar tab search: filters tabs and sub-tabs of the active workspace,
  // and temporarily forces its tree open so hits are visible
  const tabSearch = document.getElementById("tab-search");
  tabSearch.addEventListener("input", () => {
    tabQuery = tabSearch.value.trim();
    if (tabQuery) {
      const ws = activeWorkspace();
      if (ws) ws.treeCollapsed = false;
    }
    renderSidebar();
  });
  tabSearch.addEventListener("keydown", (e) => {
    e.stopPropagation(); // don't trigger the app-level shortcuts while typing
    if (e.key === "Escape") { tabSearch.value = ""; tabQuery = ""; renderSidebar(); }
  });

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

  // ---- settings ----
  //
  // Devtil's MCP server runs inside this process and is exposed over the
  // Streamable HTTP transport at /mcp, so an agent can use the toolbox while
  // devtil is open without launching anything. It ships enabled; this panel
  // is where you turn it off, or narrow what it exposes.

  const AGENT_RULES = `## Devtil tools & knowledge

Devtil is connected over MCP. It exposes this project's real infrastructure
(Kafka, databases, Elasticsearch, Kubernetes, SSH) plus a shared knowledge
bundle in Open Knowledge Format.

### Look before you dig

Before investigating anything about this system's infrastructure, data or
operations — what a table holds, why a topic is shaped the way it is, how a
service is deployed, what broke last time — call \`okf_search\` first. A
previous session may already have written it down.

Use \`okf_neighbors\` to pull in the context around a concept you found.

### Write down what will still be true next month

After you learn something durable, record it with \`okf_write\`:

- what a table, topic, index or queue actually **means** — the semantics you
  had to infer, not the schema you can already read
- **why** something is the way it is: a partitioning choice, a retention
  setting, a workaround and the constraint behind it
- a **runbook**: symptom → how to confirm it → how to fix it
- the **shape of a payload** you had to reverse-engineer from real messages

Do not record transient state, anything obvious from the code, or credentials.

Every concept needs a \`type\` — a short string like \`Database Table\`,
\`Kafka Topic\`, \`Runbook\`, \`Service\` or \`Decision\` — plus a \`title\`
and a one-line \`description\`.

### Link it, or it is lost

In the body, link related concepts with ordinary markdown links to their
bundle paths, e.g. a link to /tables/customers.md. Those links are the graph.
When you add a concept, also link to it from the closest existing one.

### Target the right system

The developer has several clusters and databases — dev, staging, production.
They are different systems, not copies. Reading the wrong one wastes a minute;
writing to the wrong one does not.

Call \`devtil_connections\` before infrastructure work: it gives each
connection's name, environment and which is the default. Then:

- If the developer named a system, use it.
- If they did not and more than one could fit, **ask them**. Do not guess.
  Devtil refuses an ambiguous request anyway and tells you to ask.
- Anything marked \`production\` must be named explicitly, and only after the
  developer confirms they mean production. Devtil never selects it for you.
- Every result carries a \`connection\` block saying which system was used and
  how it was chosen. Read it, and name the system when you report back.

Use the connection name — never ask for a password, and never write
credentials into a concept.

### Be careful with the writes

\`kafka_produce\`, mutating \`db_query\`, \`kube_exec\` and \`ssh_exec\` act on
real systems. Say what you are about to run, on which connection, and get
agreement first.`;

  function mcpSettings() {
    if (!state.settings) state.settings = {};
    if (!state.settings.mcp) state.settings.mcp = {};
    const m = state.settings.mcp;
    if (!m.groups) m.groups = {};
    if (!m.tools) m.tools = {};
    if (!m.connections) m.connections = {};
    return m;
  }

  const mcpEnabled = () => mcpSettings().enabled !== false;
  const mcpAllConns = () => mcpSettings().connectionsAll !== false;
  const groupOn = (id) => mcpSettings().groups[id] !== false;
  const toolOn = (groupId, name) => {
    const m = mcpSettings();
    return name in m.tools ? m.tools[name] : groupOn(groupId);
  };

  function settingsRow(label, help, control) {
    return el("div", { class: "set-row" }, [
      el("div", { class: "set-row-text" }, [
        el("span", { class: "set-row-label", text: label }),
        help ? el("span", { class: "set-row-help", text: help }) : null,
      ]),
      control,
    ]);
  }

  function checkbox(checked, onchange) {
    const input = el("input", { type: "checkbox" });
    input.checked = checked;
    input.addEventListener("change", () => onchange(input.checked));
    return input;
  }

  function codeBlock(text) {
    const pre = el("pre", { class: "set-code" });
    pre.textContent = text;
    return el("div", { class: "set-code-wrap" }, [
      pre,
      el("button", {
        class: "btn set-copy", text: "Copy",
        onclick: (e) => Devtil.copyText(text, e.currentTarget),
      }),
    ]);
  }

  async function openSettings() {
    const overlay = el("div", { class: "settings-overlay" });
    const body = el("div", { class: "settings-body" });
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);

    overlay.append(el("div", { class: "settings-panel" }, [
      el("div", { class: "settings-head" }, [
        el("h2", { text: "Settings" }),
        el("button", { class: "icon-btn", text: "×", title: "Close (Esc)", onclick: close }),
      ]),
      body,
    ]));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.body.append(overlay);

    body.append(el("div", { class: "set-loading", text: "Loading…" }));

    let info = { groups: [], connections: [], bundle: "" };
    try {
      info = await api("GET", "/api/mcp/info");
    } catch (e) {
      body.replaceChildren(el("div", { class: "set-error", text: "Could not load MCP settings: " + e.message }));
      return;
    }

    const render = () => {
      const m = mcpSettings();
      const endpoint = `${location.origin}/mcp`;
      const configJson = JSON.stringify({
        mcpServers: { devtil: { type: "http", url: endpoint } },
      }, null, 2);

      const sections = [];

      // ---- MCP server -------------------------------------------------
      sections.push(el("section", { class: "set-section" }, [
        el("h3", { text: "MCP server" }),
        el("p", { class: "set-lead", text: "Lets an AI agent use Devtil's tools while you work. It runs inside this app over the Streamable HTTP transport — nothing extra to start." }),
        settingsRow(
          "Enable the MCP server",
          mcpEnabled() ? "Agents can connect right now." : "The endpoint refuses every request.",
          checkbox(mcpEnabled(), (on) => { m.enabled = on; save(); render(); })
        ),
        el("div", { class: "set-sub" + (mcpEnabled() ? "" : " set-dim") }, [
          el("span", { class: "pane-label", text: "Endpoint" }),
          codeBlock(endpoint),
          el("span", { class: "pane-label", text: "Add this to your agent's MCP config" }),
          codeBlock(configJson),
          el("p", { class: "set-note", text: "For a host that only speaks stdio, run: devtil mcp" }),
        ]),
      ]));

      // ---- tools ------------------------------------------------------
      const groupNodes = info.groups.map((g) => {
        const enabled = groupOn(g.id);
        const toolRows = g.tools.map((t) => el("label", { class: "set-tool" }, [
          checkbox(toolOn(g.id, t.name), (on) => {
            // an explicit tick that matches its group is just "follow the
            // group" — drop the override so the group keeps controlling it
            if (on === groupOn(g.id)) delete m.tools[t.name];
            else m.tools[t.name] = on;
            save();
            render();
          }),
          el("code", { text: t.name }),
          el("span", { class: "set-tool-title", text: t.title }),
          t.readOnly ? el("span", { class: "set-badge", text: "read-only", title: "Only observes — safe for a host to auto-approve" }) : null,
        ]));
        return el("details", { class: "set-group" + (enabled ? "" : " set-dim") }, [
          el("summary", {}, [
            checkbox(enabled, (on) => {
              m.groups[g.id] = on;
              // toggling a group is a decision about all of it; clear the
              // per-tool exceptions rather than leaving invisible ones behind
              for (const t of g.tools) delete m.tools[t.name];
              save();
              render();
            }),
            el("span", { class: "set-group-label", text: g.label }),
            el("span", { class: "set-group-count", text: `${g.tools.length} tool${g.tools.length === 1 ? "" : "s"}` }),
          ]),
          el("p", { class: "set-note", text: g.desc }),
          el("div", { class: "set-tools" }, toolRows),
        ]);
      });
      sections.push(el("section", { class: "set-section" }, [
        el("h3", { text: "Tools exposed to agents" }),
        el("p", { class: "set-lead", text: "Untick a group to hide it entirely, or expand one to control single tools. Anything hidden is also refused if an agent asks for it from a cached list." }),
        ...groupNodes,
      ]));

      // ---- connections ------------------------------------------------
      // Picking the wrong cluster is the expensive mistake, so this section
      // is about targeting as much as it is about access: which systems an
      // agent may reach, which one it gets when it doesn't say, and which are
      // production and must always be named explicitly.
      if (!m.defaults) m.defaults = {};
      if (!m.env) m.env = {};

      const connNodes = [];
      if (!info.connections.length) {
        connNodes.push(el("p", { class: "set-note", text: "No saved connections yet. Add them in the Kafka, database or Elastic tools and they will appear here." }));
      } else {
        const byTool = new Map();
        for (const c of info.connections) {
          if (!byTool.has(c.tool)) byTool.set(c.tool, []);
          byTool.get(c.tool).push(c);
        }
        for (const [tool, list] of byTool) {
          connNodes.push(el("div", { class: "set-conn-group", text: list[0].toolLabel }));
          for (const c of list) {
            const shared = mcpAllConns() || !!m.connections[c.key];
            const isDefault = (m.defaults[tool] || "") === c.name;

            const envSel = el("select", { class: "set-env", title: "How agents should treat this system" }, [
              el("option", { value: "", text: "unlabelled" }),
              el("option", { value: "development", text: "development" }),
              el("option", { value: "staging", text: "staging" }),
              el("option", { value: "production", text: "production" }),
            ]);
            envSel.value = m.env[c.key] || "";
            envSel.addEventListener("change", () => {
              if (envSel.value) m.env[c.key] = envSel.value;
              else delete m.env[c.key];
              // production is never handed out automatically, so it cannot
              // also be the default — drop the pairing rather than keep a
              // setting that silently does nothing
              if (envSel.value === "production" && (m.defaults[tool] || "") === c.name) delete m.defaults[tool];
              save();
              render();
            });

            const isProd = (m.env[c.key] || "") === "production";
            const defBtn = el("button", {
              class: "btn set-default" + (isDefault ? " active" : ""),
              text: isDefault ? "★ default" : "make default",
              title: isProd
                ? "A production connection is never selected automatically — an agent must name it"
                : "Agents get this one when they don't name a connection",
              onclick: () => {
                if (isProd) return;
                if (isDefault) delete m.defaults[tool];
                else m.defaults[tool] = c.name;
                save();
                render();
              },
            });
            if (isProd) defBtn.disabled = true;

            connNodes.push(el("div", { class: "set-conn" + (shared ? "" : " set-dim") }, [
              mcpAllConns()
                ? el("span", { class: "set-conn-spacer" })
                : checkbox(!!m.connections[c.key], (on) => { m.connections[c.key] = on; save(); render(); }),
              el("span", { class: "set-conn-name", text: c.name }),
              el("span", { class: "set-note set-conn-sum", text: c.summary }),
              envSel,
              defBtn,
            ]));
          }
        }
        // Say plainly what happens for each tool that has no default set.
        const undecided = [...byTool.entries()]
          .filter(([tool, list]) => list.length > 1 && !(m.defaults[tool] || ""))
          .map(([, list]) => list[0].toolLabel);
        if (undecided.length) {
          connNodes.push(el("p", { class: "set-note", text:
            `No default set for: ${undecided.join(", ")}. An agent that doesn't name a connection will be refused and told to ask you — which is usually what you want.` }));
        }
      }

      sections.push(el("section", { class: "set-section" }, [
        el("h3", { text: "Connections agents can use" }),
        el("p", { class: "set-lead", text: "An agent names a connection and Devtil supplies the credentials itself — they are never returned to the model. A connection you don't share is invisible: the agent can't even learn it exists." }),
        settingsRow(
          "Share every saved connection",
          mcpAllConns() ? "Including any you add later." : "Only the ones ticked below.",
          checkbox(mcpAllConns(), (on) => { m.connectionsAll = on; save(); render(); })
        ),
        el("p", { class: "set-lead", text: "Label each system so an agent targets the right one. Devtil never picks between several clusters on its own — with no default it refuses and makes the agent ask you, and a production system is never selected automatically at all." }),
        ...connNodes,
      ]));

      // ---- agent rules ------------------------------------------------
      sections.push(el("section", { class: "set-section" }, [
        el("h3", { text: "Make agents actually use it" }),
        el("p", { class: "set-lead", text: "Connecting Devtil gives an agent the ability to use the knowledge bundle, not the habit. Paste these rules into the file your agent reads as standing instructions — CLAUDE.md, AGENTS.md, .cursor/rules — and it will search before investigating and write down what it learns." }),
        codeBlock(AGENT_RULES),
        el("p", { class: "set-note", text: "Knowledge bundle: " + (info.bundle || "—") }),
      ]));

      body.replaceChildren(...sections);
    };

    render();
  }

  document.getElementById("open-settings").addEventListener("click", openSettings);

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
