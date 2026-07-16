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
| **API Client** | Postman-like: any method, custom headers, body, response viewer with status/time/size, pretty-printed JSON, headers tab, request history. Requests are proxied through the Go backend so CORS never gets in the way, with an opt-in "skip TLS verification" for dev servers |
| **Kube Logs** | Uses your local `kubectl`/kubeconfig: pick a context & namespace, find pods for a service by name/label, fetch logs from one or many pods (multi-pod lines are prefixed with the pod name), tail/since filters, and grep (substring or regex) with match highlighting |
| **Notepad** | Autosaving scratch pads with char/word/line counts |
| **Generators** | UUID v4 (bulk), random strings/tokens, SHA-1/256/384/512 hashes |
| **Timestamps** | Auto-detects epoch seconds/millis/date strings; converts to ISO, local, relative |
| **Regex Tester** | Live match highlighting, capture groups, match list |
| **Text Diff** | Line-by-line LCS diff with added/removed counts |

## Workspaces, tabs & autosave

- Create as many **workspaces** as you like (per project, per task…). Rename
  with a double-click, delete with confirmation.
- Inside a workspace, open **tabs** — each tab is one tool instance with its
  own inputs and results. `Ctrl/Cmd+K` opens the tool picker.
- **Everything is autosaved** (debounced) to disk via the backend — inputs,
  outputs, API responses, request history, fetched logs, notes. Kill the app,
  reopen it later, and every workspace and tab is exactly as you left it.
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
- **Kube integration** shells out to your `kubectl`, so it honours existing
  kubeconfigs, contexts and auth plugins; devtil stores no credentials. If
  `kubectl` isn't installed the tool degrades gracefully with a hint.

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
