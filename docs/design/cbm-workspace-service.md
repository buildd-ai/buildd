# Grounding `spec_compare` in the code graph — and why the pipeline is already built

**Status:** proposed (substantially revised 2026-08-29 after review)
**Follows:** [codebase-memory-mcp-integration.md](./codebase-memory-mcp-integration.md) §6, #1743, #1889

## 0. Revision note — read this first

The first draft of this document proposed building a runner-side job to index the
mainline checkout with CBM and push canonical symbol records into
`{workspaceId}:code`. **That pipeline already exists and runs in production**, built
on SCIP + ast-grep rather than CBM. The original draft did not cite it, and its
central recommendation was therefore largely redundant.

What survives review is a much smaller and different finding: **buildd has two code
graphs and consumes neither.** The rest of this document is rewritten around that.

## 1. What already exists (verified on `origin/dev`)

**A runner-side ingest poller.** `apps/runner/src/knowledge-ingest.ts`, wired into
the runner at `apps/runner/src/workers.ts:412` / `:527`, polled every heartbeat tick
at `:560` — the same `setInterval(...).catch(() => {})` idiom as the other runner
pollers. It claims queued ingest jobs, reads the tree via `git ls-tree`/`git show`
(no working-tree mutation), and chunks with ast-grep symbol-boundary alignment.
This replaced an older CI-cron ingest (`.github/workflows/knowledge-ingest.yml`,
deleted in v0.175.0).

**A precise graph, enabled in this deployment.** With `KNOWLEDGE_SCIP=1` the poller
additionally runs `scip-typescript` and pushes call/import edges through
`POST /api/knowledge/ingest-jobs/[id]/graph`, which is authenticated
(`authenticateApiKey`), workspace-scoped, and idempotent by construction
("re-running a job re-converges the graph"). It writes real
`knowledge_entities` / `knowledge_edges` / `knowledge_aliases` tables.

`KNOWLEDGE_SCIP=1` is set for this workspace in the infrastructure repo at
`templates/claude-code/main.tf:254`, and `@sourcegraph/scip-typescript` is baked
into the workspace image at `build/Dockerfile:63`. **This is live right now.**

**Identity is already file-anchored.** `packages/core/knowledge-store/scip-parser.ts:341`:

```ts
return { file, key: `${file}#${qualifiedName}`, qualifiedName, terminalName };
```

That is the `(file_path, name)` scheme the previous draft called a "required
mitigation" for CBM's path-derived names. SCIP never had that problem, so the
mitigation is moot for the existing pipeline.

**Freshness scaffolding already exists.** `knowledge_ingest_jobs`
(`packages/core/db/schema.ts:1646-1667`) carries `sha` and `finishedAt`, with a
unique index on `(workspaceId, sha, scope)`. Per-workspace last-successful-SHA and
completion time are already recorded. The previous draft specced this as new work.

## 2. The actual gap

`spec_compare` (`packages/core/mcp-tools.ts:3732-3796`) does exactly two things:
a hybrid `ks.query` against the `spec` and `code` **chunk** namespaces, then
`extractImplementationAnchors(specHits)` — pure regex over chunk text
(`mcp-tools.ts:3960-3985`): file-path patterns, `/api/...` routes, camelCase ≥6
chars, PascalCase ≥6 chars, capped at 20.

**It never reads `knowledge_entities` or `knowledge_edges`.** The precise graph is
being populated and nothing consumes it for anchor resolution.

Meanwhile the *other* graph — per-worker CBM, fixed and enforcing as of #1889 — is
also unconsumed: `/api/cbm/metrics` reports `cbmActive.count: 5` with
`avgToolCalls: {}`, meaning the graph was mounted, indexed in ~12s, injected into
`mcpServers`, and **never queried** by any agent.

So the shape of the problem is not missing graph infrastructure. It is:

| graph | populated? | consumed? |
|---|---|---|
| SCIP entities/edges (`{workspaceId}:code`) | yes, live | **no** — `spec_compare` uses regex |
| Per-worker CBM (ephemeral worktree index) | yes, since #1889 | **no** — zero tool calls observed |

Two working producers, zero consumers. That is the same failure pattern as the
four-week `binary_absent` outage (#1743): built, wired, unobserved, unused.

## 3. Revised recommendation

**Do not build a second ingest pipeline.** Do these instead, smallest first:

1. **Make graph consumption observable** (prerequisite for judging anything else).
   `/api/cbm/metrics` has zero consumers, and its `avgToolCalls` is the one field
   that answers "do agents use the graph." Surface it. If it stays empty across a
   meaningful number of structural tasks, prompt-steering (#1889) did not work and
   needs a different intervention.
   Also stop reporting cohort difference as efficacy: `specTargets` currently
   compares post-fix `cbmActive` workers against pre-fix `cbmDisabled` workers and
   produced an `inputTokenDeltaPct` of −0.808 that has **no mechanism behind it**,
   because tool calls were zero. Same-window comparison at minimum.

2. **Wire `spec_compare` to the graph that already exists.** Replace or augment
   `extractImplementationAnchors` with a lookup against `knowledge_entities` /
   `knowledge_aliases`, keyed on the existing `file#qualifiedName` / `canonicalName`.
   Estimated ~50-150 LOC in `mcp-tools.ts`. This is the whole original point of
   parent-spec §6.2 and needs no new extractor.

3. **Return tri-state instead of a boolean.** `resolved+drift`, `resolved+clean`,
   `unresolved-anchor`. In a spec-driven repo, specs routinely describe symbols that
   do not exist yet — there is nothing to resolve against, and `unresolved-anchor` is
   a signal rather than an error. Keep regex as the fallback for that case.

4. **Surface freshness from data already stored.** Read `knowledge_ingest_jobs.sha`
   / `finishedAt`, report the lag in `spec_compare` output, and degrade to a warning
   past a threshold rather than answering blind against a stale graph. ~30-50 LOC.
   A silently stale drift detector is worse than an unavailable one.

## 4. The open decision this document cannot make

**Does CBM add anything over SCIP for this use case?** SCIP already provides
call/import edges with better identity. CBM's claimed marginal value (per the parent
spec's table) is pre-computed blast-radius and hub-detection style queries that a raw
edge table does not answer directly. That may be real, but:

- Nobody has compared the two on an actual `spec_compare` failure case.
- No CBM bulk-symbol-dump path exists — `cbm-bootstrap.ts` only invokes
  `index_repository`, and CBM's CLI exposes per-query tools, not a full dump. An
  extractor would have to page 63k nodes through repeated stdio invocations. That is
  genuinely new code with an unknown API surface.
- Adding CBM as a second producer requires the existing `scip:*` / `astgrep:*` edge
  `rule`-tagging discipline (`edge-builder.ts:156,179`) so the graphs layer
  additively instead of clobbering each other.

**Recommendation: leave CBM as the per-worker interactive tool it now is, and do not
make it a second ingest producer until step 1 shows agents actually use a graph and
step 2 shows SCIP's edges are insufficient.**

## 5. Option A (inbound CBM service) — still rejected, unchanged

Retained from the original draft because the reasoning stands independently:

- CBM 0.9.0 has no HTTP query API. Its transports are stdio MCP, one-shot
  `cli <tool>`, and `--ui=true --port=N`, which is a graph visualization bound to
  localhost, not a JSON query contract. A service means a shim you write and operate.
- There is no inbound path to the workspace: Coder's default port share level is
  `owner`, and host Tailscale is logged out. Vercel functions could not use the
  tailnet regardless without Enterprise private networking.
- `spec_compare` runs on Vercel, which has no repo checkout for `--repo-path`.

None of this changes. It is simply no longer the interesting question, because the
push side is already solved by a pipeline that exists.

## 6. Secondary: moving worker DB operations into the workspace

Unchanged from the original draft and still the firm boundary:

**Claim and gating stay server-side.** They are correct only while one authority
serializes them; a workspace recreated on every start must not hold that authority.
Fencing tokens are the standard guard even with a single authority.

**Append-only telemetry is the only legitimate candidate** — progress ticks,
milestones, the CBM counters. Requirements: crash-tolerant across the runner's
`while true` restart loop, never authoritative, and buffered inside `/home/coder`
(the only path that survives container recreation). Use idempotent dedupe keys so
at-least-once delivery is safe.

**Commit to a numeric threshold before measuring** — writes/sec, bytes/sec, p95
request-path contribution, storage growth — or the measurement will not produce a
decision. Do not start here; there is no demonstrated cost yet.
