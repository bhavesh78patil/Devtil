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
