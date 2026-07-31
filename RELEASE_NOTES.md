# Devtil v1.0.0

A local-first developer utilities workbench — all the small tools you reach
for every day, organised into autosaved workspaces and tabs, shipped as a
single dependency-free binary (with an optional native desktop app).

## Highlights

**Everyday tools**
- **JSON Tools** — format, minify, validate (line/col errors), sort keys,
  escape ⇄ unescape
- **XML ⇄ JSON** — convert either way, preserving attributes, nested
  elements and repeated tags (round-trips cleanly)
- **Base64**, **URL** encode/decode + breakdown, **JWT** decoder,
  **Timestamps**, **Regex tester**, **Text diff**, **Generators**
  (UUID / random / SHA)
- **Notepad** — multiple autosaving pads as inner tabs

**API client (Postman-style)**
- Request tabs, headers, body, response viewer; **auth** (Basic / Bearer /
  API key, per request or inherited from the collection); **Collection** with a base URL
  and **global headers**; **History**; import endpoints from a
  **Swagger/OpenAPI** URL. Requests are proxied through the backend so CORS is
  never in the way.

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
- **Kube Console**: connect over SSH (password) to the kubemaster, find pods,
  and open a **terminal panel per container** — tail logs live, run any
  command, search a whole folder, minimize/maximize/close
- **SSH / PuTTY**: fully **interactive terminals** (real PTY over WebSocket
  with xterm.js) — `vim`/`top`/colours/tab-completion work; multiple sessions,
  **broadcast typing** to all, **saved hosts**, copy/paste
- **SFTP / Files**: WinSCP-style browser — list directories and download files

**Workspaces & UX**
- Workspaces + tabs, all **autosaved**; rename tabs/workspaces; collapsible
  sidebar; **light & dark** themes (warm cream + orange / coffee-ink dark); an
  **App Logs** tool for debugging

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
