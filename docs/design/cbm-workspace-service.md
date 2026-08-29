# CBM as a Workspace Service — grounding KnowledgeStore in the code graph

**Status:** proposed
**Date:** 2026-08-29
**Follows:** [codebase-memory-mcp-integration.md](./codebase-memory-mcp-integration.md) §6 (symbol-graph grounding), #1743, #1889

## 1. What this is for

`spec_compare` and the `{workspaceId}:code` corpus answer structural questions with
embeddings and regex. That is documented as insufficient in the parent spec §6.1:
prose spec queries ("auto-merge approval gate") produce near-zero code evidence
against identifier-heavy embeddings, and the two-hop regex anchor fix "degrades
when specs use only prose and the symbol names have changed."

CBM answers exactly those questions precisely — canonical AST symbol names,
callers, dependents, call chains. The parent spec §6.2 already prescribes using it
to ground spec_compare's anchor extraction. §6.3 defers it behind three
prerequisites. This document addresses prerequisite 2, which is the only
architectural one:

> 2. The graph must be available at spec_compare call time (requires CBM to be
>    running as a server, not just as an offline index)

## 2. Why it is not currently possible

`spec_compare` is implemented in `packages/core/mcp-tools.ts` and served from
`apps/web` — a Next.js app on Vercel. That execution environment has:

- **no CBM binary**, and
- **no repo checkout.** This is the blocking one. CBM requires
  `--repo-path <dir>` pointing at a real filesystem tree. There is nothing on a
  Vercel function for it to index.

Meanwhile the Coder workspace container has both: the binary at
`/opt/buildd/bin/codebase-memory-mcp` (0.9.0, live since 2026-08-29) and the
mainline checkouts under `/home/coder/project/<repo>`.

So the question is how to connect the environment that has the question to the
environment that has the code.

## 3. Measured constraints

All measured in the running Coder workspace on 2026-08-29, not estimated.

**CBM has no HTTP query API.** `--help` on 0.9.0 gives exactly three transports:

```
codebase-memory-mcp                    Run MCP server on stdio
codebase-memory-mcp cli <tool> [json]  Run a single tool
--ui=true --port=N                     HTTP graph visualization (default 9749)
```

`--ui` is a graph *visualization* surface, not a documented JSON query contract.
**There is no "just run it as a service" option — a shim is required either way.**
This is the single most important finding here; any plan that assumes a native
endpoint is wrong.

**Indexing is cheap.** buildd repo, 63,861 nodes / 77,831 edges, at
`CBM_MEM_BUDGET_MB=512`:

| mode | wall |
|---|---|
| default | 10s |
| moderate | 7s |
| fast | 6s |

**There is no inbound network path to the workspace today.** Coder's port 3000 is
closed to the public (ACCESS_SETUP.md), and Tailscale on the host is logged out
(`tailscale status` → `NeedsLogin`). Vercel functions are not on the tailnet and
could not use it even if it were up.

**Baseline to beat**, from `/api/cbm/metrics` for the 7 days before the fix:
60 workers, `fallbackRate: 1.0` against a `0.05` target, avg 1,804,394 input
tokens and 4.85 file-access calls per worker.

## 4. Two shapes, and they are not equivalent

### Option A — inbound HTTP service (what was literally asked for)

A small HTTP shim inside the workspace container, owning a warm index of the
mainline checkouts, exposing authenticated JSON over an endpoint Vercel can call.

- Started by the Coder template's `startup_script`, alongside the existing buildd
  runner screen session, with the same `while true` supervision.
- Warm index of `/home/coder/project/<repo>`, refreshed via `detect_changes` on a
  timer rather than reindexing blindly.
- `POST /graph/:tool`, bearer token, explicit read-only tool allowlist. The
  parent spec's `CBM_BLOCKED_TOOLS` (`delete_project`, `manage_adr`,
  `ingest_traces`) must be unreachable, and `codebase-memory-mcp install` must
  never be invoked — it writes MCP config into 43 agent surfaces (parent spec §3).
- **Requires solving inbound networking.** The only realistic option today is an
  outbound-initiated tunnel (Cloudflare Tunnel or equivalent) that yields a public
  hostname. Tailscale does not help here.

Costs: a new public attack surface in front of a process that can read every
repo; a live availability coupling where a stopped or restarting workspace
degrades a web-app code path; and a tunnel plus token to operate.

### Option B — invert the direction (recommended)

Do not let Vercel call in. **The runner is already inside the workspace**, already
has CBM, and already makes authenticated outbound calls to buildd.dev. Use it.

- A runner-side job indexes the mainline checkout on a schedule (or on push) and
  extracts canonical records: symbols, defining files, call and dependency edges.
- It **pushes** those into the `{workspaceId}:code` corpus through an existing
  authenticated API.
- `spec_compare` keeps its current two-hop shape, but the anchor step resolves
  against pre-populated canonical symbols instead of regex guesses — fixing
  renames and ambiguous abbreviations (`PgStore` → `PgVectorStore` vs
  `PgStoreLegacy`), which is precisely the §6.2 failure mode.

Why this is better for this use case:

- **No inbound networking, no tunnel, no new public surface.**
- **Availability coupling is substituted, not removed.** If the workspace is
  down, KS serves stale anchors instead of failing. That is preferable ONLY with
  the freshness contract in §4a — without it, this is a silent-staleness
  generator, which for a drift detector is worse than an outage.
- **It is already the prescribed pipe.** Parent spec line 364 says the offline
  structural graph should populate "the KnowledgeStore with stable structural
  edges that survive across sessions, visible in `spec_compare`, and queryable via
  `query_knowledge`." That was written for SCIP. CBM can fill the same pipe in 10s
  with a binary that is already deployed.
- Latency is not on the request path, so prerequisite 3 ("spec_compare must
  absorb 2–3 additional graph round-trips") disappears rather than being met.

**Recommendation: Option B.** Keep Option A on the shelf for a future need that
Option B genuinely cannot serve — an interactive graph view in the web UI, or
per-worktree WIP queries from outside the workspace.

### What neither option changes

The per-worker ephemeral CBM shipped in #1889 stays exactly as it is. It indexes
each worker's own worktree, so it sees **uncommitted work** — its whole advantage.
A shared service indexes the mainline checkout and cannot replace it. These are
two different consumers with different freshness requirements, and conflating
them is the main design risk here.

## 4a. The failure mode Option B substitutes rather than removes

An earlier draft of §4 claimed Option B "removes the availability coupling." That
was too generous, and the distinction matters more than the original framing did.

- **Option A fails loud and closed.** Workspace stopped → the request errors. Bad,
  but you know the answer is unavailable.
- **Option B fails quiet and open.** Workspace stopped, or the indexer simply
  hasn't run since the last mainline merge → `spec_compare` still returns an
  answer, resolved against a stale symbol snapshot. Confident, wrong drift
  verdicts: missed drift, or phantom drift against symbols that have since moved.

For a drift detector specifically, silent staleness is arguably worse than an
outage: the tool's only value is being trustworthy about whether code matches
spec. Trading a loud failure for a quiet one is the same bug class that let CBM sit
`binary_absent` for four weeks (#1743) — a subsystem degrading where nobody can
see it.

Option B is still the right default. It is only *safe* with the following, which
are therefore requirements and not enhancements.

### Freshness contract (required)

1. Every pushed record carries the **mainline commit SHA** it was indexed from and
   an **indexed-at timestamp**.
2. `spec_compare` compares that SHA against mainline HEAD and **surfaces the lag**
   in its output ("index is N commits / T minutes behind").
3. Past a threshold, it **degrades to a warning and refuses a confident verdict**
   rather than answering blind. N and T must be chosen before implementation, not
   discovered in production.

This is what production code-intel does. Sourcegraph links every precise index to
a specific commit and keeps an explicit stale flag on the commit graph, so a
completed upload is not used to resolve queries at commits it cannot serve. The
same discipline applies here in miniature.

## 4b. Symbol identity is path-derived — measured, and it constrains the design

Verified against the deployed 0.9.0 binary:

```json
{"name":"buildCbmActivation",
 "qualified_name":"home-coder-project-buildd.apps.runner.src.cbm-enforcement.buildCbmActivation",
 "file_path":"apps/runner/src/cbm-enforcement.ts"}
```

Two consequences:

**Moves break anchors exactly like renames.** The qualified name embeds
`apps.runner.src.cbm-enforcement`. Relocate the file and the identity changes even
though the symbol is semantically identical. So "the graph fixes renames" is true
but narrower than it sounds — it fixes *identifier* renames, not relocation,
split, or merge.

**The project prefix is derived from the checkout path.** `home-coder-project-buildd`
comes from `/home/coder/project/buildd`. The same symbol indexed from the mainline
checkout and from a worker's worktree under
`/home/coder/.buildd/roles/.../buildd_<hash>-...` therefore gets **different
qualified names**. Pushed canonical records keyed on `qualified_name` would not
match anything a per-worker CBM produces, and would silently churn if the checkout
path ever changed.

Required mitigations:

- Pin the project name explicitly via `index_repository --name <repo>` ("Override
  the derived project name") so the prefix is stable and path-independent.
- Use **`(file_path, name)`** as the stored identity — both are returned as
  separate fields — rather than the composite `qualified_name`.
- Store the commit SHA alongside, so a move is representable as a change between
  two known commits instead of an unexplained anchor miss.

### Anchor resolution must be confidence-tiered, not a replacement

Symbol resolution cannot cover every case, and one gap matters specifically for a
spec-driven repo: **specs routinely describe symbols that do not exist in code
yet.** There is nothing to resolve against, so resolution alone cannot detect
"spec says X, code has not built X" — which is a case this project cares about.

`spec_compare` should therefore return distinct states rather than a boolean:

| state | meaning |
|---|---|
| `resolved + drift` | anchor found, code disagrees with spec |
| `resolved + clean` | anchor found, code matches |
| `unresolved-anchor` | no such symbol — in a spec-first flow this is a **signal**, not an error |

Regex anchoring stays as the fallback for `unresolved-anchor`. Also known-uncovered
and worth documenting rather than discovering: re-exports through barrel files can
resolve to the re-export site, and type-only renames have weaker identity than
call-graph edges.

## 5. Secondary: moving worker DB operations into the workspace

Raised as secondary; treating it as such, with one firm boundary.

**Claim and gating must stay server-side. Not negotiable.** Claim routing,
dedupe, subject gates, dependency gates and concurrency caps are the correctness
core; they are correct *because* a single authority serializes them. Moving them
into a workspace that is recreated on every start reintroduces races and destroys
the single source of truth.

**Legitimate candidates** are high-volume append-only telemetry where loss is
tolerable: progress ticks, milestones, `cbmToolCounts` / `cbmFileAccessCounts`,
tool-result metadata. These could buffer locally and batch-flush asynchronously.

**Constraints any such move must respect:**

- The workspace container is recreated from its image on every start; only
  `/home/coder` survives (it is a mounted volume). Anything buffered elsewhere is
  lost on restart.
- The workspace can be auto-stopped. Local state must be crash-tolerant and
  never authoritative.
- The runner already restarts itself via `screen` + `while true`, so a flush
  buffer must survive process restart, not just crash.

**Do not start here.** Measure the actual write volume and latency per worker
first. Right now this is a solution without a demonstrated cost.

## 6. Sequencing — deliberately gated

Prerequisite 1 of parent spec §6.3 is "CBM must be integrated and stable." As of
2026-08-29 it is *integrated*: the binary is live, enforcement fires, and #1889
fixed the pre-index and told agents the graph exists. It is **not yet shown to be
stable or effective** — the 7-day metrics window still reads `fallbackRate: 1.0`
because everything before today was `binary_absent`.

**Do not build this until the baseline moves.** The whole value of Option B is
better anchors for spec_compare; if CBM turns out not to change `fallbackRate` or
input tokens, the grounding bridge is optimizing an unproven foundation. Wait for
a clean 7-day window showing `cbmActive.count > 0` and a real
`inputTokenDeltaPct` / `fileAccessDeltaPct`.

That gate also depends on someone actually reading `/api/cbm/metrics`, which
still has zero consumers in the codebase.

## 7. Task breakdown (not filed)

1. **Surface the CBM metrics.** Give `/api/cbm/metrics` a consumer so §6's gate is
   observable. Prerequisite for everything below.
2. **Confirm the effect.** One clean 7-day window with CBM active. Record
   `fallbackRate`, `inputTokenDeltaPct`, `fileAccessDeltaPct`. Decision point: if
   the deltas are flat, stop and reconsider rather than building the bridge.
3. **Extractor.** Runner-side job: index mainline checkout, emit canonical
   symbol/file/edge records. Reuse the `runCbmBootstrap` invocation shape from
   `cbm-bootstrap.ts` — note `--repo-path` is required (#1889).
4. **Ingest path.** Upsert those records into `{workspaceId}:code` (the existing
   corpus convention — `{workspaceId}` is repo-scoped in buildd, 1:1 with a
   repoUrl, so no re-keying is needed), versioned by commit sha so stale edges are
   replaceable rather than duplicated. Identity is `(file_path, name)` + sha, NOT
   `qualified_name` (§4b). Pin the project name with `--name`.
4b. **Freshness signal.** Store and expose indexed-sha + indexed-at; implement the
   staleness threshold and the degrade-to-warning path from §4a. This is not
   optional — it is what makes Option B safe rather than merely cheap.
5. **Anchor grounding.** Replace regex anchor extraction in `spec_compare`'s
   second hop with canonical-symbol lookup, keeping regex as fallback.
6. **Measure again.** spec_compare code-evidence hit rate before/after, against
   the §6.1 vocabulary-gap cases (task `a61de0b5`, PR #1429).

## 8. Open questions

- Does the `{workspaceId}:code` corpus schema accommodate typed edges (calls,
  imports, dependents), or does grounding only need symbol→file anchors? The
  latter is much cheaper and may be sufficient for §6.2.
- Which repos get indexed? The workspace holds ten-plus checkouts under
  `/home/coder/project/`. Indexing all of them on a timer is a different cost
  profile than indexing buildd alone.
- Refresh trigger: timer, push webhook, or `detect_changes` polling. A 10s index
  is cheap enough that this is a scheduling question, not a performance one.
- Does anything else want an inbound workspace endpoint? If two or three
  consumers appear, Option A's tunnel cost amortizes and the calculus changes.
