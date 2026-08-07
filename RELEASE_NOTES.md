# Devtil v1.0.0

A local-first developer utilities workbench — all the small tools you reach
for every day, organised into autosaved workspaces and tabs, shipped as a
single dependency-free binary (with an optional native desktop app).

## Highlights

**Everyday tools**
- **JSON Tools** — format, minify, validate (line/col errors), sort keys,
  escape ⇄ unescape
- **JSONPath** — evaluate expressions (filters, slices, recursive descent,
  regex) against a document, with matched values or paths
- **XML ⇄ JSON** — convert either way, preserving attributes, nested
  elements and repeated tags (round-trips cleanly)
- **Base64**, **URL** encode/decode + breakdown, **JWT** decoder,
  **Timestamps**, **Regex tester**, **Text diff**, **Generators**
  (UUID / random / SHA)
- **Notepad** — multiple autosaving pads as inner tabs

**API client (Postman-style)**
- **Multiple collections**, each with its own name, base URL, global headers
  and auth — shown as a **searchable request tree**: type to filter every
  collection at once by request name, path or method
- **Collection tabs** — click a collection to open its own view (rename, base
  URL, global headers, auth, Swagger import, export) alongside request tabs
- **Rename** collections and requests inline from the tree; delete with
  confirmation
- Saved requests keep their **headers, body and auth**, so opening one,
  editing it and pressing **Save** updates it in place — **Save as…** files a
  copy into any collection, or a new one
- **Swagger/OpenAPI import** lands in the collection you're in (and offers to
  name it from the document title) instead of scattering endpoints
- **Auth** (Basic / Bearer / API key) per request or inherited from the
  collection; **History**; export a collection to JSON and import it back as a
  new one. Requests are proxied through the backend so CORS is never in the way.

**Infra clients**
- **Kafka** (multi-cluster): topic dropdown, read latest / from-beginning /
  time-range, key & value search, newest-first messages with pretty-printed
  values (maximize with Value/Headers tabs), produce with headers,
  configurable timeout
- **Elastic / OpenSearch**: REST console + a **visual query builder** that
  generates clauses from each field's schema type (term/match/range/nested)
- **Cassandra** and **Relational Databases** (Oracle, MySQL, PostgreSQL):
  SQL/CQL consoles with a schema-aware table+column query helper. Pure-Go
  drivers (no DB client install); connect with host/port fields or a single
  URL, and a **schema** field sets where to query
- **Export to CSV / Excel** from the Elastic, Cassandra and Relational-DB
  consoles — pick the row count (default 1000, max 10 000)

**Kube & remote access**
- **Kube Console**: **saved clusters** — name a connection once (SSH host,
  port, password, context, namespace) and pick it from a dropdown instead of
  retyping it; agents reach the same clusters by name over MCP. **Find
  services** lists a namespace's services with their ports and selector, and
  clicking one resolves the pods it actually fronts. Then open a **terminal
  panel per container** — tail logs live, run any command, search a whole
  folder, minimize/maximize/close
- **SSH / PuTTY**: fully **interactive terminals** (real PTY over WebSocket
  with xterm.js) — `vim`/`top`/colours/tab-completion work; multiple sessions,
  **broadcast typing** to all, **saved hosts**, copy/paste
- **SFTP / Files**: WinSCP-style browser — list directories and download files

**Use it from an AI agent (MCP)**
- Devtil speaks the **Model Context Protocol**, exposing all **34 tools** to
  any agent host: the offline utilities, the HTTP client, Kafka,
  Oracle/MySQL/PostgreSQL, Cassandra, Elasticsearch, Kubernetes and SSH
- **On by default**, served from the running app over the **Streamable HTTP**
  transport at `http://127.0.0.1:8347/mcp` — nothing extra to start. Point an
  agent at it with `{"type": "http", "url": "…/mcp"}`, or run `devtil mcp` for
  a host that only speaks stdio
- Agents reference a **saved connection by name** — devtil reads the
  credentials from your local state file and never returns them to the model
- Tools that only observe are annotated read-only, so a host can auto-approve
  them while still asking before anything writes

**Settings panel**
- New **⚙ Settings** in the sidebar: turn the MCP server on or off, copy the
  endpoint and a ready-made agent config, and control exactly what is exposed
- **Per-group and per-tool switches** — let an agent read Kafka but never
  produce, hide SSH entirely, and so on. A hidden tool is refused even if an
  agent asks for it from a cached list
- **Per-connection sharing** — an unshared connection is invisible to agents,
  not merely unusable
- **Environment labels and a default per tool** — devtil never guesses which
  of your clusters an agent meant. With several and no default it refuses and
  tells the agent to ask you; a connection labelled **production** is never
  selected automatically at all. Every result reports which connection was
  used and how it was chosen
- Changes apply to the agent's next call; nothing needs restarting
- Ships with a copy-paste **agent rules** block (also in `AGENT_RULES.md`)
  that gets agents searching the knowledge bundle before they investigate and
  writing down what they learn

**Knowledge Graph (OKF)**
- A new tool for **Open Knowledge Format** bundles (v0.2): knowledge as plain
  markdown files with YAML frontmatter, where the file path is a concept's
  identity and markdown links form the graph
- **Interactive graph** — scroll to zoom, drag to pan, drag a node to pin it
  (pins persist), hover to isolate a concept's neighbourhood, node size by how
  many links a concept has, and a type legend that doubles as a filter
- **Share a bundle**: export the whole thing as a zip, import someone else's.
  Imports merge — your own concepts are never overwritten unless you ask — and
  can land under a folder of their own
- A concept editor showing what each one links to and is linked from
- Agents read and write the **same bundle** over MCP, so what one records
  while it works is there for you to read, correct and commit

**Workspaces & UX**
- Workspaces + tabs, all **autosaved**; rename tabs/workspaces; collapsible
  sidebar; **search your tabs** from the sidebar and collapse a workspace's
  tab tree; **light & dark** themes (warm cream + orange / coffee-ink dark);
  an **App Logs** tool for debugging

## Install

Pick one:

- **Standalone binary** (no install) — download the file for your OS below,
  make it executable, and run it; the UI opens in your browser.
  - macOS Apple Silicon: `devtil-darwin-arm64`
  - macOS Intel: `devtil-darwin-amd64`
  - Windows: `devtil-windows-amd64.exe`
  - Linux: `devtil-linux-amd64`
- **Native desktop app** — the macOS `.dmg` or Windows setup `.exe`. The
  desktop app **auto-updates**: it checks for new releases on launch and, on
  Windows, downloads and installs them in the background (restart to finish);
  on macOS it nudges you to download the new version.

Verify a download against `SHA256SUMS` if provided.

### Opening on macOS

The `.dmg` / `.app` is **not notarized** (that needs a paid Apple account), so
macOS may say **"Devtil.app is damaged and can't be opened."** It isn't damaged
— that's just Gatekeeper blocking an un-notarized download. Clear the
quarantine flag once and open normally:

```sh
xattr -dr com.apple.quarantine /Applications/Devtil.app
# standalone binary instead:
xattr -d com.apple.quarantine devtil-darwin-arm64 && chmod +x devtil-darwin-arm64
```

The Mac app is ad-hoc signed and universal (runs on Apple Silicon and Intel).
On Windows, SmartScreen may warn on first run — choose **More info → Run
anyway**.

## Privacy

Devtil binds to `127.0.0.1` only, sends **no telemetry**, and stores your
data locally. See [SECURITY.md](SECURITY.md) for how credentials are handled.
