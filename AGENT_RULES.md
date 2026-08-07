# Agent rules for Devtil

Connecting Devtil over MCP gives an agent the *ability* to use your toolbox
and your knowledge bundle. It does not give it the *habit*. Models do what the
task in front of them asks for; without an instruction, they will dive into
the work and never think to check what a previous session already learned.

Closing that gap takes one paste. Copy the block below into whichever file
your agent reads as standing instructions:

| Agent | File |
|---|---|
| Claude Code | `CLAUDE.md` in your repo root |
| Cursor | `.cursor/rules/devtil.mdc` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| Windsurf | `.windsurfrules` |
| Most others | `AGENTS.md` in your repo root |

---

## The rules

````markdown
## Devtil tools & knowledge

Devtil is connected over MCP. It exposes this project's real infrastructure
(Kafka, databases, Elasticsearch, Kubernetes, SSH) plus a shared knowledge
bundle in Open Knowledge Format.

**The knowledge bundle is the memory for this project. Read it before you
work, and write to it as you go.** Treat it the way you would treat the
codebase: the source of truth, kept current, not a place for occasional notes.

### Always search first

Before investigating anything about this system's infrastructure, data or
operations — what a table holds, why a topic is shaped the way it is, how a
service is deployed, what broke last time, what someone already tried — call
`okf_search`. Do this **first, every time**, before running a query, reading a
topic or opening a runbook. A previous session may already have the answer.
Searching costs one call; rediscovering costs many, and the answer is usually
worse.

Then use `okf_neighbors` on whatever you found to pull in the surrounding
context in one go, rather than reading concepts one at a time. `okf_graph`
shows how a whole domain hangs together when you are new to it.

If the bundle turns out to be wrong or out of date, **fix it** in the same
session. A stale concept is worse than a missing one.

### Write down everything you establish

The rule is simple: **if you worked it out and it will still be true next
week, it goes in the bundle** — via `okf_write`, before you report back. Not
"if it seems important enough". Default to writing.

That explicitly includes **everything you verify or correct**:

- **A finding** — `type: Finding`. Something you established by looking:
  this column is nullable in practice, this topic has 12 partitions, this
  service actually reads from the replica. Record what you observed **and how
  you observed it**, so the next session can re-check it.
- **A correction** — when you discover the bundle, the docs, a comment or an
  assumption was wrong, write the correct version and say what was wrong
  before. Corrections are the highest-value thing in here.
- **A verification** — `type: Verification`. You checked something and it held.
  Say what you checked, against which connection, and when. "Confirmed X" is
  worth recording precisely because the next session would otherwise re-check.
- **A bug or defect** — `type: Bug`. Symptom, the reproduction, the root cause
  if you found it, and whether it is fixed.
- **A decision** — `type: Decision`. Why something is the way it is: a
  partitioning choice, a retention setting, a workaround and the constraint
  behind it.
- **A runbook** — `type: Runbook`. Symptom → how to confirm → how to fix.
- **Meaning** — what a table, topic, index or queue actually *means*: the
  semantics you had to infer, not the schema anyone can already read.
- **A payload shape** you reverse-engineered from real messages.

Do **not** record: transient state (current lag, today's row counts), anything
already obvious from the code, secrets or credentials of any kind, or a
restatement of official docs.

Every concept needs a `type`; give it a `title` and a one-line `description`.
When a finding is about a specific system, name the connection you used —
`prod-payments` and `dev-cluster` may not agree, and a finding without its
subject is not reusable.

### Link it, or it is lost

A concept nobody links to is a concept nobody finds. In the body, link to
related concepts with ordinary markdown links to their bundle paths:

    Joined with [customers](/tables/customers.md) on `customer_id`.
    When this alerts, follow [checkout latency](/runbooks/checkout-latency.md).

Those links *are* the knowledge graph. **Every concept you write must link to
at least one existing concept**, and you should add a link back to it from the
closest existing one. An unlinked concept shows up as an orphan in Devtil's
graph view — treat that as a defect in your own work.

Run `okf_validate` when you have finished writing: it catches concepts missing
a type and links that point nowhere.

### Record what changed

Append a line to the bundle's history with `okf_log` when you add or correct
something significant. It is the changelog for the project's knowledge, and it
is how a human reviewing your work sees what you touched.

### Target the right system

The developer has several clusters and databases — dev, staging, production.
They are **different systems**, not copies. Reading the wrong one wastes a
minute; writing to the wrong one does not.

Call `devtil_connections` before infrastructure work. It gives you each
connection's name, environment and which is the default. Then:

- If the developer named a system, use it.
- If they did not and more than one could fit, **ask them**. Do not guess.
  Devtil will refuse an ambiguous request anyway and tell you to ask.
- Anything marked `production` must be named explicitly, and only after the
  developer has confirmed they mean production. Devtil never selects it for
  you.
- Every result carries a `connection` block saying which system was used and
  how it was chosen. Read it, and say which system you used when you report
  back.

Use the connection **name** — never ask the developer to paste a password, and
never write credentials into a knowledge concept.

For Kubernetes, work the way the question is asked. Someone says "checkout is
erroring", not "pod checkout-7d4f is erroring": call `kube_services` to see
what is in the namespace, then pass `service: "checkout"` straight to
`kube_logs` with a `grep` — it resolves the service's pods for you and tells
you which ones it read. Don't list pods first unless you need a specific one.

### Use what the developer already has

The developer's own workspace is open beside you, and you can read it:

- **`api_collections` / `api_request`** — they have already saved the requests
  for this system, with the right base URL, headers and auth. Find one by name
  and send it with `api_request` rather than rebuilding the call yourself; the
  credentials are applied on the way out and never reach you. Override the
  body or a header for one call without changing what is saved.
- **`notepad_list` / `notepad_read`** — when they say "the notes I made about
  X", this is where those notes are. These are read-only: anything *you* want
  to keep goes in the knowledge bundle with `okf_write`, which is file-backed
  and survives.
- **`devtil_logs`** — Devtil's own diagnostic log, with every kubectl and ssh
  command it ran and every request it proxied (secrets redacted). Read it when
  one of your tool calls failed and the error was not enough to explain why.
  Check here **before** asking the developer what went wrong.
- **`sftp_read`** — read a config or log file straight off a remote host when
  nothing else exposes it.

### Be careful with the writes

`kafka_produce`, `db_query` with a mutating statement, `kube_exec` and
`ssh_exec` act on real systems. Say what you are about to run, **on which
connection**, and get agreement before running anything that changes state.

`api_request` sends a real request too — a saved `DELETE` is still a delete.
Say which request you are about to send, and to which collection's base URL,
before sending anything that is not a read.
````

---

## Making it stick

A few things that make the difference between rules that work and rules that
get skimmed past:

- **Put it near the top.** Instructions at the end of a long file compete with
  everything above them.
- **Seed the bundle.** An agent will not search an empty bundle twice. Write
  two or three real concepts by hand — a table you care about, one runbook —
  and the search-first habit starts paying off immediately.
- **Only expose what you mean to.** Devtil's Settings → MCP server panel
  controls which tool groups and which saved connections agents can reach.
  Narrow it and the agent's choices get better, not worse.
- **Review what it writes.** The bundle is markdown in a directory you can
  commit. Read the diff like any other generated code.
