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

### Look before you dig

Before investigating anything about this system's infrastructure, data or
operations — what a table holds, why a topic is shaped the way it is, how a
service is deployed, what broke last time — call `okf_search` first. A
previous session may already have written it down. Searching costs one call;
rediscovering it costs many, and the answer is often worse.

Use `okf_neighbors` to pull in the context around a concept you found, rather
than reading concepts one at a time.

### Write down what will still be true next month

After you learn something durable, record it with `okf_write`:

- what a table, topic, index or queue actually **means** — the semantics you
  had to infer, not the schema you can already read
- **why** something is the way it is: a partitioning choice, a retention
  setting, a workaround and the constraint behind it
- a **runbook**: symptom → how to confirm it → how to fix it
- the **shape of a payload** you had to reverse-engineer from real messages

Do **not** record: transient state (current lag, today's row counts), anything
already obvious from the code, secrets or credentials of any kind, or a
restatement of official docs.

Every concept needs a `type` — a short free-form string like `Database Table`,
`Kafka Topic`, `Runbook`, `Service` or `Decision`. Give it a `title` and a
one-line `description`.

### Link it, or it is lost

A concept nobody links to is a concept nobody finds. In the body, link to
related concepts with ordinary markdown links to their bundle paths:

    Joined with [customers](/tables/customers.md) on `customer_id`.
    When this alerts, follow [checkout latency](/runbooks/checkout-latency.md).

Those links *are* the knowledge graph. When you add a concept, also add a link
to it from the most closely related existing concept.

### Prefer saved connections

Infrastructure tools take a `connection` name that resolves against what the
developer saved in Devtil — call `devtil_connections` to see them. Use the
name. Never ask the developer to paste a password, and never write credentials
into a knowledge concept.

### Be careful with the writes

`kafka_produce`, `db_query` with a mutating statement, `kube_exec` and
`ssh_exec` act on real systems. Say what you are about to run and why, and get
agreement before running anything that changes state.
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
