# 🧰 Devtil — Developer Utilities Workbench

Devtil is a local-first developer utilities app: all the small tools you reach
for every day (JSON formatting, Base64, an API client, Kubernetes log search,
scratch pads…) organised into **workspaces and tabs**, with **everything
autosaved** so you can close it and resume exactly where you left off.

It ships as a **single Go binary** with the web UI embedded — run it and it
opens in your browser. For a native Mac/Windows app experience there is an
**Electron shell** (Node) in `desktop/` that spawns the same binary and wraps
the UI in an app window.

## Tools included

| Tool | What it does |
|---|---|
| **JSON Tools** | Pretty-format, minify, validate (with line/col errors), sort keys, escape ⇄ unescape JSON strings |
| **Base64** | Encode/decode, unicode-safe, URL-safe variant, live conversion |
| **URL Tools** | Encode/decode components or full URIs, plus a URL/query-param breakdown table |
| **JWT Decoder** | Decode header & payload, human-readable `exp`/`iat`/`nbf`, expiry check |
| **API Client** | Postman-like layout: a **side panel** with the saved **Collection** and **History**, and **inner request tabs** in the main area. Clicking a saved or historical request opens it in its own tab (re-clicking focuses the existing tab), each with its own method, headers, body and response — status/time/size, pretty-printed JSON, response-headers view. Requests are proxied through the Go backend so CORS never gets in the way, with an opt-in "skip TLS verification" for dev servers. The collection holds a base URL, endpoints imported from a Swagger/OpenAPI JSON URL (pick individual endpoints or select all) or saved via "Save to collection", and **global headers** automatically sent with every request under the base URL (request-level headers override on conflict) |
| **Kube Console** | Connect to the kubemaster **over SSH with a username/password** (built-in SSH client — no keys or ssh binary needed), pick a context and namespace, and find pods for a service by name/label. Then **click any container to open a terminal panel** — a MobaXterm-like grid where each panel can **tail logs live** (follow), **run any command** in that container (`kubectl exec`), **search a whole folder** (`grep -rIn` / `ls`), and be **minimized, maximized or closed** independently. Panels, their output and commands autosave and persist |
| **SSH / PuTTY** | **Fully interactive SSH terminals** — real PTYs streamed over a WebSocket into embedded [xterm.js](https://xtermjs.org/), so `vim`, `top`, `htop`, tab-completion and colours all work. Open **multiple sessions** (password auth) as panels in one tab; type once in the **broadcast bar** to send the same input to every session with 📡 enabled (MobaXterm-style multi-exec). **Copy** (⧉ button, `Ctrl+Shift+C`, or auto-copy on select) and **paste** (📋, `Ctrl+Shift+V`) work while plain `Ctrl+C` stays as SIGINT. Each panel minimizes, maximizes, reconnects (⟳) and closes independently; sessions survive tab switches and reconnect on reload |
| **SFTP / Files** | WinSCP-style remote file browser over SFTP (password auth): list directories, navigate in/out (folders first), and **download files to your machine** with one click. Paths and the current listing persist |
| **Kafka** | Connect to **multiple clusters** (plain, SASL/PLAIN, TLS) with a **configurable timeout (ms, default 1000)** per cluster: **List topics** populates a **topic dropdown** (type-or-pick), read messages from **latest, the beginning, or a time range** (start + optional end), **search by key and/or value** (case-insensitive substring, scans a wider window and reports matched/scanned counts), and produce messages. Consumed messages are shown **newest-first** with each value **JSON pretty-printed**, collapsible, and openable **full-screen** (⤢ Maximize). Pure-Go client, no local Kafka tooling needed |
| **Elastic / OpenSearch** | Per-cluster connections with basic auth: one-click cluster health / indices / nodes, plus a free-form REST console for `_search` and any other endpoint, with pretty-printed responses. A **visual query builder** lists the cluster's indices, loads the selected index's mapping, and lets you add **per-field conditions** whose clause is chosen automatically from the field's schema type — `term`/`terms`/`prefix`/`wildcard` for keyword, `match`/`match_phrase` for text, `range` (`>`, `≥`, between) for numbers and dates, `true`/`false` for boolean, `exists` for anything — combine **multiple fields** with ALL (bool.must) or ANY (bool.should), and **nested** fields are auto-wrapped in a `nested` query on their path. The `_search` body is generated live as you edit, with a `_source` projection picker for the returned columns |
| **Cassandra** | CQL console against multiple connections (contact points, keyspace, auth) with a results grid, row limits, and Ctrl+Enter to run. The **query helper** lists tables from `system_schema`, shows the chosen table's **columns as checkboxes**, and generates the `SELECT … LIMIT …` for you |
| **Oracle** | SQL console using a pure-Go driver — **no Oracle client install required** — with results grid and DML support (rows-affected reporting). Same **query helper**: pick from `user_tables`, choose columns, and the `SELECT … FETCH FIRST n ROWS ONLY` is generated |
| **App Logs** | Devtil's own diagnostic log, viewable in-app: every kubectl/ssh command it ran (secrets redacted) with duration, stdout size and stderr, every proxied HTTP call, DB/Kafka connections, and UI errors — with tail size, substring filter, auto-refresh and copy. The file lives at `<data dir>/devtil.log` (5 MB rotation) |
| **Notepad** | Autosaving scratch pads with char/word/line counts — **multiple pads as inner tabs** per notepad, auto-named from their first line, deleted only when you close them (with confirmation if non-empty) |
| **Generators** | UUID v4 (bulk), random strings/tokens, SHA-1/256/384/512 hashes |
| **Timestamps** | Auto-detects epoch seconds/millis/date strings; converts to ISO, local, relative |
| **Regex Tester** | Live match highlighting, capture groups, match list |
| **Text Diff** | Line-by-line LCS diff with added/removed counts |

## Navigation

Two levels, consistent across the app:

- **Main workspace nav** (left sidebar): workspaces, each holding tool tabs.
  Minimise it with the **☰ button** in the tab bar — the collapsed state is
  remembered.
- **Tab-specific nav** inside the bigger tools: the API client has a
  Collection/History side panel with inner request tabs, and the
  Kafka/Elastic/Cassandra/Oracle tools have a **connections side panel**
  (add/edit/delete clusters, click one to make it active — green dot) with
  **inner console tabs** on the right, so one tool tab can hold many parallel
  queries against many clusters.

## Workspaces, tabs & autosave

- Create as many **workspaces** as you like (per project, per task…). Rename
  with a double-click, delete with confirmation.
- Inside a workspace, open **tabs** — each tab is one tool instance with its
  own inputs and results. `Ctrl/Cmd+K` opens the tool picker.
- **Light & dark themes** — a selector in the sidebar (light is the
  default); the choice is saved with the rest of your state.
- **Everything is autosaved** (debounced) to disk via the backend — inputs,
  outputs, API responses, request history, fetched logs, notes, cluster
  connections, console queries and results. Kill the app, reopen it later,
  and every workspace and tab is exactly as you left it. Nothing is dropped
  unless you delete it from the tab yourself. Note that connection
  credentials are stored in the local state file — it lives in your user
  config directory and the app only listens on localhost, but treat that
  file as sensitive.
- State lives in `<user config dir>/devtil/state.json` (e.g.
  `~/Library/Application Support/devtil` on macOS, `%AppData%\devtil` on
  Windows, `~/.config/devtil` on Linux), written atomically with a `.bak`
  rotation so a crash mid-write never loses your data.

## Quick start (browser mode)

```sh
make build          # or: go build -o bin/devtil .
./bin/devtil        # starts on http://127.0.0.1:8347 and opens your browser
```

Flags: `-port 9000` (0 picks a free port), `-data /path/to/dir`, `-no-browser`.

## Native desktop app (Mac/Windows)

```sh
make build                  # build the Go backend first
cd desktop
npm install
npm start                   # dev: native window wrapping the local backend
npm run dist                # package a .dmg / .exe installer (electron-builder)
```

The Electron shell spawns the Go binary, waits for it to become healthy, and
opens the UI in an app window; quitting the app stops the backend.

## Cross-compiling the backend

```sh
make cross    # dist/devtil-{darwin-arm64,darwin-amd64,windows-amd64.exe,linux-amd64}
```

## Releases via GitHub Actions

`.github/workflows/release.yml` builds everything people need to install
devtil:

- **Standalone Go binaries** for macOS (arm64 + amd64), Windows and Linux —
  download, `chmod +x`, run; the UI opens in the browser.
- **Native desktop installers** — a macOS `.dmg` and a Windows setup `.exe`
  built with Electron on real mac/windows runners (unsigned by default; add
  signing secrets to ship signed builds).

Push a tag like `v1.0.0` and all artifacts are attached to the GitHub
Release automatically; the workflow can also be run manually from the
Actions tab, where artifacts are downloadable from the run page.

## Architecture

```
┌────────────────────────────┐      ┌────────────────────────────────┐
│ Electron shell (desktop/)  │      │ Go binary (single, no deps)    │
│  – native Mac/Win window   │─────▶│  – serves embedded web UI      │
│  – spawns the Go backend   │      │  – /api/state  autosave store  │
└────────────────────────────┘      │  – /api/proxy  HTTP client     │
        or just a browser ─────────▶│  – /api/kube/* kubectl wrapper │
                                    └────────────────────────────────┘
```

- **Backend** (`main.go`, `internal/`): net/http only, binds to
  `127.0.0.1` exclusively — your state, request proxy and cluster access are
  never exposed to the network.
- **Frontend** (`web/`): dependency-free vanilla JS/CSS embedded with
  `go:embed`; each tool is a small module registered in `web/js/tools.js`.
- **Kube integration** shells out to `kubectl`, so it honours existing
  kubeconfigs, contexts and auth plugins. Two ways to reach a cluster that
  your machine can't talk to directly:
  - **SSH host** (the common jump-host/kubemaster setup): enter
    `user@host` (+ optional port) and every kubectl command runs on that
    machine. With an **SSH password** set, devtil uses its built-in Go SSH
    client (password + keyboard-interactive auth — no keys, no ssh binary
    needed). Without a password it falls back to your system `ssh` with
    key/agent auth and an optional identity file. Either way arguments are
    safely quoted for the remote shell, and contexts, namespaces and pods
    are listed from the remote host's kubeconfig. Local kubectl isn't
    needed in this mode.
  - **API server address**: passed to kubectl as `--server` (a bare IP is
    auto-prefixed with `https://`) with optional `--token` and
    `--insecure-skip-tls-verify`.

  devtil stores no cluster credentials, and if `kubectl`/`ssh` are missing
  the tool degrades gracefully with a hint.

## Adding a new tool

Register it in `web/js/tools.js`:

```js
Devtil.registerTool({
  type: "mytool", icon: "★", name: "My Tool", desc: "What it does.",
  defaults: () => ({ input: "" }),                 // persisted per tab
  render(root, tab, ctx) { /* build DOM; call ctx.save() on changes */ },
});
```

It automatically appears in the new-tab picker, and its `tab.data` is
autosaved and restored like every other tool.
