# Security & Privacy

Devtil is a **local-first** developer tool. It is designed so your data and
credentials stay on your machine.

## How Devtil handles your data

- **Localhost only.** The backend binds exclusively to `127.0.0.1` — it is
  never reachable from your network. The API (state, request proxy, SSH/DB
  clients) cannot be accessed by other machines.
- **No telemetry.** Devtil makes **no** outbound calls of its own. The only
  network requests are the ones *you* trigger: the API client hitting the URL
  you type, the SSH/SFTP/Kafka/DB/Elastic clients connecting to the hosts you
  configure. Nothing is sent to the author or any third party.
- **No embedded secrets.** The repository contains no credentials, keys, or
  tokens. CI builds are unsigned by default and use no secrets unless you add
  your own signing certificates.

## Where credentials live

Connection details you enter — SSH passwords, saved hosts, Kafka SASL
credentials, database passwords, bearer tokens — are saved with the rest of
your workspace state so sessions can resume. **This file is stored in
plaintext** on your own machine at:

- macOS: `~/Library/Application Support/devtil/state.json`
- Windows: `%AppData%\devtil\state.json`
- Linux: `~/.config/devtil/state.json`

Treat that file as sensitive: it is readable by your user account and is **not
encrypted**. It never leaves your machine, is never committed to git (the app
writes it outside any repo), and is only ever sent from the browser tab to the
local backend over `127.0.0.1`.

If you would rather not persist a password, clear the field before closing —
or delete the connection/session, which removes it from state. A future
option to keep credentials out of the state file (prompt-per-use, or OS
keychain integration) is tracked as an enhancement.

## Giving an AI agent access (`devtil mcp`)

`devtil mcp` hands the toolbox to whatever agent launches it. Be deliberate
about that — it is a real grant of capability, not a read-only integration.

What the agent **can** do: everything the tools do. Run SQL, produce to a
Kafka topic, `kubectl exec` into a pod, run a command over SSH, send an HTTP
request from your machine to any host you can reach.

What the agent **cannot** do: read your credentials. When it references a
saved connection by name, devtil looks the credentials up from your local
state file, uses them, and returns only the result. Passwords, tokens and
SASL secrets are never included in a tool's response, and `devtil_connections`
lists names and hosts only. An agent that passes connection fields *inline*
is, of course, using whatever it was given.

Devtil marks tools that only observe with MCP's `readOnlyHint` so a host can
auto-approve them. `kafka_produce`, `db_query`, `cassandra_query`,
`kube_exec`, `ssh_exec`, `http_request` and the `okf_*` writers are **not**
marked read-only — keep the approval prompt on for those, and point the agent
at non-production connections while you are getting a feel for it.

The MCP server speaks over stdio to the process that launched it. It opens no
port and accepts no network connections.

**Knowledge bundles.** `okf_*` tools read and write markdown under the bundle
directory only; concept paths are normalised and clamped to the bundle root,
so a path containing `../` cannot write elsewhere on disk. Treat the bundle as
agent-authored content: review it before committing it, the same as any other
generated file.

## Logs

Devtil writes a diagnostic log (`<data dir>/devtil.log`, viewable in the **App
Logs** tool). It is careful with secrets:

- HTTP request query strings are dropped from the log (they can carry tokens).
- `kubectl --token` values are redacted.
- SSH/DB/Kafka passwords are never written to the log — only the host and
  command are recorded.

## Reporting a vulnerability

Please open a GitHub issue for non-sensitive reports, or contact the
maintainer privately for anything that could put users at risk. Include steps
to reproduce and the affected version.
