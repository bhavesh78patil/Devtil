# 🧰 Devtil — Developer Utilities Workbench

Devtil is a local-first developer utilities app: all the small tools you reach
for every day (JSON formatting, Base64, an API client, Kubernetes log search,
scratch pads…) organised into **workspaces and tabs**, with **everything
autosaved** so you can close it and resume exactly where you left off.

It ships as a **single Go binary** with the web UI embedded — run it and it
opens in your browser. For a native Mac/Windows app experience there is an
**Electron shell** (Node) in `desktop/` that spawns the same binary and wraps
the UI in an app window.

Devtil is **local-first**: the backend binds to `127.0.0.1` only, sends **no
telemetry**, and keeps all your data on your machine. See
[SECURITY.md](SECURITY.md) for how credentials are handled.

## Download & build

**Prebuilt (recommended):** grab your platform's file from the
[latest release](../../releases/latest) — a standalone binary
(`devtil-darwin-arm64`, `devtil-darwin-amd64`, `devtil-windows-amd64.exe`,
`devtil-linux-amd64`) or the native `.dmg` / `.exe` installer. Verify against
`SHA256SUMS`.

### Opening on macOS (unsigned app)

Devtil isn't notarized by Apple (that needs a paid developer account), so on
first launch macOS may say **"Devtil.app is damaged and can't be opened"** or
**"cannot be opened because Apple cannot check it for malicious software"**.
The app is fine — this is just Gatekeeper blocking an un-notarized download.
Clear the quarantine flag once, then open normally:

```sh
# for the app:
xattr -dr com.apple.quarantine /Applications/Devtil.app
# or for the standalone binary:
xattr -d com.apple.quarantine ~/Downloads/devtil-darwin-arm64 && chmod +x ~/Downloads/devtil-darwin-arm64
```

(On Windows, SmartScreen may warn — choose **More info → Run anyway**.)

**Build it yourself for Windows & Mac** (needs Go 1.25):

```sh
make cross    # → dist/devtil-{darwin-arm64,darwin-amd64,windows-amd64.exe,linux-amd64}
```

**Cut a public release** — push a version tag and GitHub Actions builds and
attaches every binary + installer + checksums to a GitHub Release, using
`RELEASE_NOTES.md` as the body:

```sh
git tag v1.0.0 && git push origin v1.0.0
```

The workflow (`.github/workflows/release.yml`) can also be run manually from
the repo's **Actions** tab.

**Upload binaries to a release from your machine** — if you'd rather build
locally (or need to refresh assets on a release), use the helper script
(needs the authenticated [GitHub CLI](https://cli.github.com)):

```sh
make release TAG=v1.0.0          # build cross-platform binaries + upload to the v1.0.0 release
scripts/release.sh v1.0.0 --tag-push   # also create & push the tag (triggering CI) first
```

It runs `make cross`, writes `SHA256SUMS`, creates the release from
`RELEASE_NOTES.md` if it doesn't exist, and uploads (clobbering same-named
assets). The `.dmg`/`.exe` installers still come from CI, since they must be
built on macOS/Windows.

## Tools included

| Tool | What it does |
|---|---|
| **JSON Tools** | Pretty-format, minify, validate (with line/col errors), sort keys, escape ⇄ unescape JSON strings |
| **JSONPath** | Evaluate JSONPath expressions against a JSON document, live as you type. Supports `$`, `.key`, `['key']`, recursive descent `..key` / `..*`, wildcards, indexes incl. negative (`[-1]`), unions (`[0,2]`), slices with a step (`[1:3]`, `[::2]`), `.length`, and **filters** — `[?(@.isbn)]`, `[?(@.price < 10)]`, `==` `!=` `<` `<=` `>` `>=`, regex `=~ /re/i`, and `&&` / `||` with parentheses. Output as **matched values**, their **normalised paths**, or both; ships with a sample document and one-click examples. Pure-browser, no `eval()` and no dependencies |
| **XML ⇄ JSON** | Convert XML to JSON and back — attributes (`@attr`), text nodes (`#text`), nested elements and repeated tags (arrays) preserved; round-trips cleanly. Pure-browser, no dependencies |
| **Base64** | Encode/decode, unicode-safe, URL-safe variant, live conversion |
| **URL Tools** | Encode/decode components or full URIs, plus a URL/query-param breakdown table |
| **JWT Decoder** | Decode header & payload, human-readable `exp`/`iat`/`nbf`, expiry check |
| **API Client** | Postman-like: **multiple collections**, each with its own name, base URL, global headers and auth, shown as a **searchable request tree** in the side panel — type to filter across every collection by request name, path or method. Click a collection to open its own **collection tab** (rename, base URL, global headers, auth, Swagger import, export); click a request to open it in a **request tab**. Saved requests are complete requests — method, path, headers, body and auth — so opening one, editing it and pressing **Save** updates it in place, while **Save as…** files a copy anywhere (a small dialog picks the collection, or creates a new one). **Rename** collections and requests inline from the tree (✎), delete with confirmation. **Swagger/OpenAPI import** targets the collection you're in and offers to name it from the document title, picking up the base URL and skipping endpoints already present. **Auth** is built in — **Basic** (RFC 7617, UTF-8 safe), **Bearer** or an **API key** as header or query param — set per request or once on the collection and inherited by every request under its base URL; each editor shows the exact header it will send. Requests are proxied through the Go backend so CORS never gets in the way, with an opt-in "skip TLS verification" for dev servers. Collections **export to JSON and import back as a new collection** — credentials are left out by default (tick a box to include them). Plus **History** of everything sent, click to reopen. |
| **Kube Console** | **Saved clusters** — name a connection (SSH host, port, password, context, namespace) and pick it from a dropdown instead of retyping it; agents reach the same clusters by name over MCP. Connect **over SSH with a username/password** (built-in SSH client — no keys or ssh binary needed) or use the machine's own kubeconfig, then pick a context and namespace. **Find services** lists the namespace's services with their type, ports and pod selector — click one and Devtil resolves the pods it actually fronts (people describe problems in services; logs live in pods). Or find pods directly by name/label. Then **click any container to open a terminal panel** — a MobaXterm-like grid where each panel can **tail logs live** (follow), **run any command** in that container (`kubectl exec`), **search a whole folder** (`grep -rIn` / `ls`), and be **minimized, maximized or closed** independently. Panels, their output and commands autosave and persist |
| **SSH / PuTTY** | **Fully interactive SSH terminals** — real PTYs streamed over a WebSocket into embedded [xterm.js](https://xtermjs.org/), so `vim`, `top`, `htop`, tab-completion and colours all work. **Saved hosts** are remembered — pick one from the dropdown to prefill the form (or "New host"), with a Forget option. Open **multiple sessions** (password auth) as panels in one tab; type once in the **broadcast bar** to send the same input to every session with 📡 enabled (MobaXterm-style multi-exec). **Copy** (⧉ button, `Ctrl+Shift+C`, or auto-copy on select) and **paste** (📋, `Ctrl+Shift+V`) work while plain `Ctrl+C` stays as SIGINT. Each panel minimizes, maximizes, reconnects (⟳) and closes independently; sessions survive tab switches and reconnect on reload |
| **SFTP / Files** | WinSCP-style remote file browser over SFTP (password auth): list directories, navigate in/out (folders first), and **download files to your machine** with one click. Paths and the current listing persist |
| **Kafka** | Connect to **multiple clusters** (plain, SASL/PLAIN, TLS) with a **configurable timeout (ms, default 1000)** per cluster: the console splits into **Consume** and **Produce** modes so each gets the full pane (the topic is shared between them). **List topics** populates a **topic dropdown** (type-or-pick), read messages from **latest, the beginning, or a time range** (start + optional end), **search by key and/or value** (case-insensitive substring, scans a wider window and reports matched/scanned counts), and produce messages. Results **stream in as they are read** — messages appear while partitions are still being scanned, with a spinner, a running match count and a live elapsed timer, and the final line reports matched/scanned and the total time. Consumed messages are shown **newest-first** with each value **JSON pretty-printed**, collapsible, and openable **full-screen** (⤢ Maximize) with **Value / Headers tabs**. Produce has **Message / Headers tabs** and a **full-height value editor** that **pretty-prints JSON the moment you paste it** (with `{ } Format` / `Minify` buttons, copy, and a live readout of the payload size and whether it parses — so a broken payload reports itself before the broker does); it waits for a leader acknowledgement, and checks the topic exists first so a wrong name reports itself instead of timing out. Pure-Go client, no local Kafka tooling needed |
| **Elastic / OpenSearch** | Per-cluster connections with basic auth: one-click cluster health / indices / nodes, plus a free-form REST console for `_search` and any other endpoint, with pretty-printed responses. A **visual query builder** lists the cluster's indices, loads the selected index's mapping, and lets you add **per-field conditions** whose clause is chosen automatically from the field's schema type — `term`/`terms`/`prefix`/`wildcard` for keyword, `match`/`match_phrase` for text, `range` (`>`, `≥`, between) for numbers and dates, `true`/`false` for boolean, `exists` for anything — combine **multiple fields** with ALL (bool.must) or ANY (bool.should), and **nested** fields are auto-wrapped in a `nested` query on their path. The `_search` body is generated live as you edit, with a `_source` projection picker for the returned columns. Hits render as a **table** (with a Raw JSON toggle), and the toolbar has **CSV / Excel export** plus **Copy response** — which copies the full pretty-printed JSON for any endpoint, not just searches. The index picker, query builder and body **fold away behind a ▸ Request toggle**, leaving just the method/path/Send line — and they fold themselves the first time a response comes back, so the result gets the pane instead of the request. After that the toggle is yours, remembered per console |
| **Cassandra** | CQL console against multiple connections (contact points, keyspace, auth) with a results grid, row limits, and Ctrl+Enter to run. The **query helper** lists tables from `system_schema`, shows the chosen table's **columns as checkboxes**, and generates the `SELECT … LIMIT …` for you |
| **Relational Databases** | SQL console for **Oracle, MySQL/MariaDB and PostgreSQL** — pure-Go drivers, **no DB client install required**. Pick the engine per connection; connect with separate host/port/database fields **or paste a single URL** (`jdbc:oracle:thin:@host:1521/service`, `mysql://user:pass@host:3306/db`, `postgres://user:pass@host:5432/db`, `jdbc:` variants, or a native driver DSN). A **schema** field (Oracle owner / PostgreSQL schema / MySQL database) sets *where* to query — it drives the query helper and is applied to the session (`search_path` / `CURRENT_SCHEMA`). Each tab shows its **target engine + schema**. Results grid, DML support (rows-affected), and a schema-aware **query helper**: list tables, choose columns, and the `SELECT …` (`LIMIT` / `FETCH FIRST n ROWS ONLY`) is generated |
| **App Logs** | Devtil's own diagnostic log, viewable in-app: every kubectl/ssh command it ran (secrets redacted) with duration, stdout size and stderr, every proxied HTTP call, DB/Kafka connections, and UI errors — with tail size, substring filter, auto-refresh and copy. The file lives at `<data dir>/devtil.log` (5 MB rotation) |
| **Notepad** | Autosaving scratch pads with char/word/line counts — **multiple pads as inner tabs** per notepad, auto-named from their first line, deleted only when you close them (with confirmation if non-empty). **Find / find all / replace / replace all** with a match-case toggle and wrap-around search, plus **word wrap** and monospace toggles and line operations (UPPER, lower, sort, dedupe, trim trailing space, drop blank lines) that apply to the selection or the whole pad. Keyboard: `Ctrl/Cmd+F` find, `Ctrl/Cmd+H` replace, `Enter`/`F3` next, `Shift+Enter`/`Shift+F3` previous, `Esc` close, and `Tab` indents instead of leaving the editor |
| **Generators** | UUID v4 (bulk), random strings/tokens, SHA-1/256/384/512 hashes |
| **Timestamps** | Auto-detects epoch seconds/millis/date strings; converts to ISO, local, relative |
| **Regex Tester** | Live match highlighting, capture groups, match list |
| **Text Diff** | Line-by-line LCS diff with added/removed counts |
| **Knowledge Graph** | Browse and edit an **Open Knowledge Format** bundle — markdown concepts with YAML frontmatter, linked into a graph. Concepts are grouped by type in a searchable, filterable list; the **graph view** is interactive — **scroll to zoom, drag the background to pan, drag a node to pin it** where you want it (pins persist), **hover a node to isolate its neighbourhood** while everything else fades, and node size tracks how many links a concept has so the hubs of a domain stand out. A **type legend** doubles as a filter, and links pointing at concepts that don't exist yet show as dashed red placeholders. Open any concept to edit its type, title, description, tags, status and markdown body, and to see what it **links to and is linked from**. **Export the whole bundle as a zip** to share or commit, and **import** someone else's — merged into yours, optionally under a folder, never overwriting your own work unless you ask. This is the same bundle `devtil mcp` gives AI agents. |

## MCP — give the toolbox to an AI agent

Devtil speaks the [Model Context Protocol](https://modelcontextprotocol.io),
so any agent host can use every tool above while you work.

**It is on by default.** While Devtil is running, the MCP server is served
from the app itself over the **Streamable HTTP** transport — nothing extra to
start, no second process:

```json
{
  "mcpServers": {
    "devtil": { "type": "http", "url": "http://127.0.0.1:8347/mcp" }
  }
}
```

**Settings → MCP server** (the ⚙ button in the sidebar) shows the exact URL
for your port with a copy button, and is where you turn the server off or
narrow what it exposes. For a host that only speaks stdio, run `devtil mcp`
instead.

**42 tools — every tab in the app**, in four groups:

- **Offline utilities** — `json_format`, `jsonpath_query`, `xml_to_json`,
  `json_to_xml`, `base64`, `url_encode`, `jwt_decode`, `hash_text`,
  `uuid_generate`, `timestamp_convert`, `regex_test`, `text_diff`. No network,
  no credentials, no side effects.
- **Infrastructure** — `http_request`, `kafka_topics`, `kafka_consume`,
  `kafka_produce`, `db_query` (Oracle/MySQL/PostgreSQL), `cassandra_query`,
  `elastic_request`, `kube_contexts`, `kube_namespaces`, `kube_services`,
  `kube_pods`, `kube_logs`, `kube_exec`, `ssh_exec`, `sftp_list`, `sftp_read`.
- **Your workspace** — `api_collections` and `api_request` send the requests
  you already saved in the API Client, with the collection's base URL, global
  headers and auth applied exactly as the UI applies them (so the agent never
  handles the credentials); `notepad_list` and `notepad_read` let an agent
  read the notes you made; `devtil_logs` is Devtil's own diagnostic log, so an
  agent whose call failed can look up *why* instead of asking you.
- **Knowledge** — `okf_search`, `okf_read`, `okf_write`, `okf_delete`,
  `okf_graph`, `okf_neighbors`, `okf_log`, `okf_validate`.

The notepad tools are deliberately **read-only**: the UI autosaves your whole
workspace every few hundred milliseconds, so a write from an agent would be
lost to your next keystroke. Durable agent notes belong in the knowledge
bundle, which is file-backed and has no such conflict.

**Connections without handing over credentials.** Infrastructure tools accept
either inline connection fields or a `connection` name that resolves against
the connections you already saved in the Devtil UI. The agent names the
cluster; devtil reads the credentials from your local state file and never
returns them. `devtil_connections` lists what's available.

**Devtil never guesses which cluster you meant.** You typically have dev,
staging and prod side by side — different systems, not copies. So when an
agent doesn't say which one it wants:

- it gets the **default** you picked for that tool, if you set one;
- or the single connection, if there's only one;
- otherwise the call is **refused**, with the candidates listed and an
  instruction to ask you. The agent comes back to you rather than picking.

A connection you label **production** is never selected automatically, even
when it's the only one — an agent has to name it explicitly, which means a
human decided. Environments and the default are set per connection in
Settings, and **every result says which connection it used and how it was
chosen**, so you can see what the agent actually touched.

Tools that only observe are annotated `readOnlyHint`, so a host can
auto-approve them while still prompting for `kafka_produce`, `db_query`,
`kube_exec` and `ssh_exec`. A tool that fails reports the message in its
result rather than as a protocol error, so the model can read it and adjust.

### Controlling what agents can reach

Settings → MCP server gives you three levels of control, and every change
takes effect on the agent's next call — nothing to restart:

- **The master switch.** Off means the endpoint refuses every request.
- **Tool groups.** Untick *SSH & SFTP* and those tools vanish from
  `tools/list`; expand a group to switch off a single tool (letting an agent
  read Kafka but never produce is a one-click change). Anything hidden is
  also **refused if an agent asks for it anyway** from a cached list.
- **Connections.** Share every saved connection, or pick them individually.
  A connection you don't share is *invisible* — an agent can't even learn it
  exists, let alone use it. Label each one `development` / `staging` /
  `production`, and mark one per tool as the default an agent gets when it
  doesn't name a system.

### Making agents actually use it

Connecting Devtil gives an agent the **ability** to use the knowledge bundle,
not the **habit**. See [AGENT_RULES.md](AGENT_RULES.md) for a drop-in block to
paste into `CLAUDE.md`, `AGENTS.md`, `.cursor/rules` or your host's equivalent
— it tells the agent to search the bundle before investigating and to write
down what it learns. The same text is in Settings with a copy button.

```
devtil mcp [-data <dir>] [-okf <dir>]     # stdio transport
  -data   data directory, used to resolve saved connections
          (default: <user config dir>/devtil)
  -okf    knowledge bundle directory (default: <data dir>/knowledge)
```

## Knowledge bundles (OKF)

[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
is Google Cloud's vendor-neutral spec for representing knowledge as plain
markdown files with YAML frontmatter. Devtil implements **OKF v0.2**.

A bundle is just a directory:

```
knowledge/
  index.md                  optional root listing (declares okf_version)
  log.md                    optional chronological history
  tables/orders.md          one file per concept
  runbooks/checkout.md
```

Each concept is markdown with a frontmatter block. The **only required field
is `type`**; everything else is the producer's choice:

```markdown
---
type: Database Table
title: Orders
description: One row per completed customer order.
tags: [sales, revenue]
generated:
  by: devtil/mcp
  at: 2026-08-01T09:14:00Z
---
# Schema

| Column | Type | Description |
|---|---|---|
| `order_id` | STRING | Globally unique order identifier. |
| `customer_id` | STRING | FK to [customers](/tables/customers.md). |
```

The file path is the concept's identity, and **ordinary markdown links are
the graph** — no database, no query language, no SDK. Because it is just
markdown, a bundle renders on GitHub, diffs in a PR, and can be committed
alongside the code it describes.

Why it's here: an agent that figures out what a table means, why a topic is
partitioned the way it is, or how to recover a stuck consumer group can write
that down once instead of rediscovering it every session — and you can read,
correct and commit what it wrote.

### Sharing a bundle

Because a bundle is just files, sharing one is just sending the files. The
Knowledge Graph tool's **Export** button downloads the whole bundle as a zip;
**Import** merges someone else's into yours:

- concepts you already have are **left alone** by default — tick *overwrite*
  only if you mean it
- an optional **folder** keeps an imported bundle in its own corner
  (`/vendor/acme/…`) instead of mixing it into yours
- non-markdown files, dotfiles and anything with a `..` in its path are
  ignored, so an untrusted archive cannot write outside the bundle
- a zip made by right-clicking the bundle folder works too: the redundant
  wrapper directory is detected and stripped

You can equally well `git clone` a bundle into the knowledge directory or
commit yours alongside your code — nothing about the format needs Devtil.

## Navigation

Two levels, consistent across the app:

- **Main workspace nav** (left sidebar): workspaces, each holding tool tabs.
  Minimise it with the **☰ button** in the tab bar — the collapsed state is
  remembered.
- **Tab-specific nav** inside the bigger tools: the API client has a
  Collection/History side panel with inner request tabs, and the
  Elastic/Cassandra/Relational-DB consoles can **export results to CSV or
  Excel** (choose how many rows, default 1000, up to 10 000); every result grid — SQL, Kafka messages and Elastic `_search` hits —
  shares one treatment: **resizable columns** (drag the header edge) and
  **expand (⤢) + copy (⧉) on every cell**, so a long key or value is never
  out of reach; expanding pretty-prints JSON; the SQL editor holds **multiple queries** — select one, or just
  put the cursor on it, and Run executes only that statement;
  Kafka/Elastic/Cassandra/Relational-DB tools have a **connections side panel**
  (add/edit/delete clusters, click one to make it active — green dot) with
  **inner console tabs** on the right, so one tool tab can hold many parallel
  queries against many clusters.

## Workspaces, tabs & autosave

**Closing a tab never deletes it.** The × on a tab only hides it — the tab
and everything inside it stay in the workspace. The sidebar shows a **tab
tree** under the active workspace: every tab (open or closed, closed ones
marked) with its **sub-tabs** — request tabs, console tabs, notepad pads,
terminal sessions, container panels — nested beneath it. From the tree you
can click to (re)open a tab or jump straight to a sub-tab, **rename** a tab
(✎ or double-click), and **delete** a tab or sub-tab permanently (with a
confirmation) — deletion only ever happens from the tree.

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

### Auto-update

The desktop app checks GitHub Releases for a newer version on launch (and every
6 hours) and nudges the user — implemented with
[`electron-updater`](https://www.electron.build/auto-update) in
`desktop/updater.js`:

- **Windows** — the update downloads silently in the background and installs on
  the next restart. A true auto-update; works even for the unsigned build.
- **macOS** — Squirrel.Mac can only *install* an update when the app is signed
  with a paid Apple Developer ID (this build is only ad-hoc signed), so the app
  nudges the user and opens the release download page instead. Once real
  signing + notarization is wired up, set `MAC_CAN_SELFINSTALL = true` in
  `desktop/updater.js` and mac auto-installs too.

For the updater to work, each release must carry the update metadata
(`latest.yml` / `latest-mac.yml`, the `.blockmap`s, and the mac `.zip`) — the
release workflow attaches these automatically. **Bump `desktop/package.json`
`version` to match the release tag** (tag `v1.2.0` → version `1.2.0`) so the
running app compares versions correctly.

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
  signing secrets to ship signed builds). Each release also carries the
  `electron-updater` metadata so installed apps auto-update (see
  [Auto-update](#auto-update)).

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
                                    │  – /api/okf/*  knowledge bundle│
┌────────────────────────────┐      │                                │
│ AI agent (any MCP host)    │─────▶│  – `devtil mcp` on stdio       │
└────────────────────────────┘      └────────────────────────────────┘
```

- **Backend** (`main.go`, `internal/`): net/http only, binds to
  `127.0.0.1` exclusively — your state, request proxy and cluster access are
  never exposed to the network.
- **Frontend** (`web/`): dependency-free vanilla JS/CSS embedded with
  `go:embed`; each tool is a small module registered in `web/js/tools.js`.
- **MCP server** (`internal/mcp/`): JSON-RPC 2.0 over stdio, calling the same
  `internal/` packages the HTTP API does — so an agent and the UI cannot
  drift apart. `internal/jsonpath/` is a Go port of the browser engine, kept
  expression-for-expression identical.
- **Knowledge bundle** (`internal/okf/`): reads and writes OKF v0.2 markdown
  bundles. Concept paths are clamped to the bundle root, so no `../` in a
  path an agent supplies can write outside it.
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
