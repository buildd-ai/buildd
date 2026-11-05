---
title: Voyage Spend Guard
status: active
owner: max
last_verified: 2026-11-05
summary: Every Voyage call MUST pass one guard at the client boundary that picks the team's own key or the plan's platform allowance, records the usage, and degrades to lexical-only retrieval when denied.
domain: billing
surfaces: [packages/core/voyage-budget.ts, packages/core/knowledge-store/voyage-guard.ts, packages/core/knowledge-store/voyage-embedder.ts, packages/core/knowledge-store/reranker.ts]
related: [knowledge-store-retrieval, knowledge-ingest-pipeline, pluggable-knowledge-store]
keywords: [voyage, BYOK, voyage_api_key, fair use, embedding spend, rerank tokens, usage.total_tokens, VOYAGE_BUDGET_ENFORCED, voyage_usage_monthly, voyage_usage_daily, lexical fallback, budgetFallback, MAX_FULL_INGEST_BYTES]
verified_by: [packages/core/__tests__/voyage-budget.test.ts, packages/core/__tests__/voyage-guard.test.ts, packages/core/__tests__/voyage-client-boundary.test.ts, packages/core/__tests__/voyage-spend-store.test.ts, packages/core/__tests__/knowledge-ingest-filter.test.ts, packages/core/__tests__/knowledge-full-ingest.test.ts]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "voyage-guard"
    type: "symbol"
    name: "createVoyageGuard"
    path: "packages/core/knowledge-store/voyage-guard.ts"
  - id: "voyage-caps"
    type: "symbol"
    name: "voyageCapsForPlan"
    path: "packages/core/voyage-budget.ts"
  - id: "voyage-usage-table"
    type: "symbol"
    name: "voyageUsageDaily"
    path: "packages/core/db/schema.ts"
  - id: "voyage-guard-tests"
    type: "test_file"
    path: "packages/core/__tests__/voyage-guard.test.ts"
---
# Voyage Spend Guard

**Capability statement**: No code path MUST reach the Voyage API except through
`VoyageEmbedder` and `VoyageReranker`, and each of those MUST ask one guard for
permission before the request and report `usage.total_tokens` after it. A team
past its allowance keeps working on lexical retrieval with no rerank, and
sees that it did. A Free team with no Voyage key of its own never calls Voyage.

## Why it looks like this

Spend grew as steady daily traffic, not as one large ingest. Voyage bills rerank
as `query tokens x documents + document tokens`, so a long query against a wide
candidate set is the expensive shape. Three recurring patterns explain the
traffic, and each is fixed at its source (see Reductions) before any cap applies:

- one claim or multi-corpus `recall` runs the same text through every corpus, so
  the same query was embedded once per corpus and reranked once per corpus;
- a team-wide memory query over-fetches, then fused up to a few dozen full chunks
  into one rerank call;
- `file_hash` skips only a byte-identical file, so a one-line edit to a large
  file re-embedded every chunk of it.

## Who pays

| Team | Embed and rerank | Limit |
|---|---|---|
| Own key (`secrets` purpose `voyage_api_key`, team-wide), any plan | on the team's key | none here; their bill |
| `pro`, `team`, no own key | on the platform key | monthly fair-use allowance: `PAID_VOYAGE_EMBED_TOKENS`, `PAID_VOYAGE_RERANK_TOKENS`, or env `VOYAGE_PAID_EMBED_TOKENS`, `VOYAGE_PAID_RERANK_TOKENS` |
| `free` or an unknown plan, no own key | none | lexical search only; the 50-document cap still applies |

This mirrors decision calls in `decision-client.ts`: the team's key first, then
the platform key under the plan. Embed and rerank are separate counters because
they are priced and sized differently. Months are UTC calendar months. A team's
own key is not counted against any allowance.

## Invariants

- **R-1 One door.** Only `voyage-embedder.ts` and `reranker.ts` name a Voyage URL.
  `Embedder.embed` and `Reranker.rerank` take a required `VoyageCall { namespace,
  caller }`, so a new call site cannot compile without saying whose spend it is.
- **R-2 Reserve, then settle.** A call reserves its estimate with one atomic
  `UPDATE ... WHERE tokens + estimate <= cap`; concurrent calls cannot jointly
  overshoot. After the response the estimate is replaced by `usage.total_tokens`.
  A failed call refunds its reservation. The estimate is deliberately high, so a
  settle lost to a frozen serverless instance errs towards refusing, not spending.
- **R-3 Team, from the namespace.** The namespace's first segment is a workspace
  id or, for `{teamId}:memory`, a team id. Both resolve to one team.
- **R-4 Fail closed.** While enforcing, a team or plan that cannot be determined
  makes no platform-key call. `loadTeamEntitlements` is not used here because it
  fails open. A failed own-key read counts as no key. A failed counter write on a
  known paid plan proceeds: the plan allows the call, only the meter is down.
- **R-5 Query headroom.** Query embeddings may run past the embed cap by
  `VOYAGE_QUERY_HEADROOM`, so one large ingest does not also switch off vector
  search for the rest of the month. Past the headroom they are denied too.
- **R-6 Degrade, never fail.** A denied embed writes the chunk with no vector and
  a null `file_hash`, so the next ingest embeds it instead of hash-skipping it. A
  denied query embed runs lexical-only. A denied rerank keeps RRF order. Hits from
  a denied path carry `scoreBreakdown.budgetFallback` and bypass score floors,
  which are calibrated to reranker scores and would otherwise drop every hit.
  `mode: 'vector'` callers get an empty result, as they do with no embedder.
- **R-7 Recorded.** Each call emits a `voyage.call` span and adds to
  `voyage_usage_daily`, keyed by day, team, kind, model, corpus, caller and key
  source (`platform` or `byok`). Metering runs whether or not the guard enforces.
- **R-8 Surfaced.** A refused paid call stamps `exhausted_at` on the monthly row.
  `GET /api/workspaces/[id]/knowledge-health` returns `voyageBudget`, and the
  workspace knowledge panel shows a notice from 80% used, or that the plan is
  keyword-only. Ingest job stats carry `chunksLexicalOnly`. A Free refusal writes
  nothing: it is that team's normal state, on the query path.

## Enforcement switch

`VOYAGE_BUDGET_ENFORCED` turns denial on (`1/true/on/yes`) or off
(`0/false/off/no`). Unset, it follows `BILLING_ENFORCED`. It is separate because
this guard protects the operator's Voyage key, which does not wait for billing to
go live, and because a self-hosted deployment pays for its own key and is not
limited unless it opts in. With it off, every call proceeds and is still metered.
`VOYAGE_BUDGET_EXEMPT_TEAMS` (comma-separated team ids, env only) keeps named
teams metered but not limited.

## Reductions

- **Query embeddings are cached** per model and text, in process, in-flight calls
  included, so a fan-out over corpora sharing a model makes one request. A hit
  makes no Voyage call and is not metered, so it can serve a team the guard would
  refuse; that costs nothing and reveals nothing but a vector of its own text.
- **Rerank is trimmed at the client**: the query to `RERANK_MAX_QUERY_CHARS`,
  each document to `RERANK_MAX_DOC_CHARS`. The store sends at most
  `RERANK_CANDIDATE_CAP` candidates, `limit * 3` below that.
- **Unchanged chunks reuse their vector.** Before embedding, the store looks up
  rows in the namespace with the same content hash, model and embedded text, so
  an edited file pays only for the chunks that changed, and a re-upserted card
  pays nothing. Lookup runs before `ingestFiles` clears the file.
- **`contentDedup` is checked before embedding**, not after.

## Ingest ceiling

A `full` job keeps files in listing order up to `MAX_FULL_INGEST_FILES` and
`MAX_FULL_INGEST_BYTES`, and records `filesOverCeiling` and `ingestTruncated` in
its stats. A truncated run MUST NOT sweep or prune: chunks of the dropped files
are not stale. `shouldIngestFile` also rejects vendored directories and generated
file names, alongside the existing dependency, lockfile, binary and size rules.

## Acceptance

- AC-1 GIVEN a free team with no own key WHEN a document chunk is upserted THEN
  no Voyage request is made, the chunk is stored with no vector and no file hash.
- AC-2 GIVEN a paid team past its rerank allowance WHEN a query runs THEN the
  results keep RRF order and carry `budgetFallback`.
- AC-3 GIVEN enforcement on WHEN the team lookup throws THEN no call is made.
- AC-4 GIVEN a paid team WHEN the counter write throws THEN the call proceeds.
- AC-8 GIVEN a free team with its own key THEN the call runs on that key and is
  recorded as `byok`, touching no allowance.
- AC-5 GIVEN four concurrent identical query embeds on one model THEN one Voyage
  request is made.
- AC-6 GIVEN a file with one changed chunk THEN only that chunk is embedded.
- AC-7 GIVEN a full job over the ceiling THEN it completes with `sweep: false`.

## Non-goals

Backfilling lexical-only chunks: the next full ingest does it. Per-workspace
keys or allowances. A dashboard form for the team's key: it is set through
`POST /api/secrets` for now. Dollar accounting: tokens are the unit, because prices move.

## Code surface

`packages/core/voyage-budget.ts`, `packages/core/knowledge-store/voyage-guard.ts`,
`packages/core/knowledge-store/voyage-embedder.ts`,
`packages/core/knowledge-store/reranker.ts`,
`packages/core/knowledge-store/pg-vector-store.ts`,
`packages/core/knowledge-store/ingest.ts`,
`packages/core/knowledge-store/ingest-filter.ts`,
`packages/core/knowledge-store/full-ingest.ts`,
`apps/web/src/lib/knowledge-full-ingest-fallback.ts`,
`apps/runner/src/knowledge-ingest.ts`,
`apps/web/src/app/api/workspaces/[id]/knowledge-health/route.ts`.
