# Workspace Knowledge Management v2 — Per-PR Ingestion, Code Graph, Semantic Supersession, Distillation

**Status:** Accepted — Wave 1 shipped (#1179, #1180, #1181); Wave 2 in flight (see §7)
**Date:** 2026-07-12
**Scope:** `packages/core/knowledge-store/`, GitHub webhook, runner, MCP tooling
**Prior art:** `docs/knowledge-store.md` (implemented), `docs/design/knowledge-graph-retrieval.md` (partially implemented)

---

## 1. Audit — what shipped vs. what didn't

The June 2026 KM push (PRs #880, #887, #914, #963/#964, #975, #1016, #1024, #1041, #1159) delivered most of `knowledge-graph-retrieval.md`:

| Capability | Status | Where |
|---|---|---|
| Hybrid retrieval (vector + BM25 + RRF + rerank-2.5) | ✅ Live | `pg-vector-store.ts` |
| Per-corpus embedders (voyage-code-3 / voyage-4-large) | ✅ Live | `voyage-embedder.ts` |
| Recency × authority scoring (Layer 1) | ✅ Live | `recency-authority.ts`, applied at `pg-vector-store.ts:288` |
| Supersession (`is_current`/`superseded_by`) | ✅ Live, **path-keyed only** | `_markSuperseded` (`pg-vector-store.ts:412`) |
| Entity tables + 3-tier resolver + pg_trgm (Layer 2) | ✅ Live | `entity-{extractor,resolver}.ts`, migration 0062 |
| Graph edges + 1-hop graph-augmented rerank (Layer 3) | ✅ Live | `edge-builder.ts`, `pg-vector-store.ts:334` |
| Work-product auto-mirroring (task/pr/plan/artifact cards) | ✅ Live | `cards.ts`, `mirrorWorkProduct` |
| Plan-time + claim-time knowledge injection | ✅ Live | `knowledge-context.ts`, `claim/route.ts:1145`, `mission-context.ts:538` |
| **SCIP / ast-grep code-structure indexing (§9)** | ❌ Never shipped | Entity extraction is regex-only (PR refs, UUIDs, wikilinks, headings) |
| **Per-PR / per-workspace code ingestion** | ❌ Absent | `knowledge-ingest.yml`: buildd repo only, push-to-dev, hardcoded workspace |
| **Semantic (entity-keyed) supersession** | ❌ Absent | Two differently-keyed chunks on the same topic never supersede |
| **Entity catalog pre-seeding into task context (§8.4)** | ❌ Absent | Agents invent loose refs; `pending_entity_refs` accumulates |
| **`session` corpus** | ❌ Unused | Type exists; nothing writes it |
| **Consolidation / decay lifecycle** | ❌ Absent | Decay is soft score-down only; stale chunks live forever |

**The structural consequence:** buildd's own workspace has a rich, fresh index; every other workspace has none. PR #1159 made this failure *explicit* ("No code index for this workspace — run ingestion first") but nothing runs ingestion. Knowledge injection at claim/plan time silently degrades to memory-corpus-only for all customer workspaces.

---

## 2. Goals

1. **Every workspace with a connected repo gets a code index automatically** — no CI setup, no manual step.
2. **Every merged PR incrementally updates that index** — changed files re-ingested, deleted files removed, old chunks superseded. Knowledge tracks HEAD, not last-Monday.
3. **The graph understands code structure** — symbols, imports, def/ref edges — not just regex-extracted PR numbers and wikilinks.
4. **Old knowledge yields to new** beyond identical file paths: entity-keyed supersession + periodic agent-driven consolidation.
5. **Summaries compound**: session outcomes, PR diffs, and weekly digests become retrievable knowledge, and agents are told what entities exist before they write.

Non-goals: replacing the external memory service (source-of-truth split stays per `knowledge-store.md`); LLM calls inside the deterministic ingest path (constraint from `knowledge-graph-retrieval.md` §3 stands — LLM work happens only in agent tasks).

---

## 3. Phase A — Per-workspace, per-PR ingestion (highest value)

### 3.1 Trigger: the existing GitHub webhook

`apps/web/src/app/api/github/webhook/route.ts` already receives `pull_request closed/merged` events with installation credentials, and `workspaces.githubRepoId → github_repos → github_installations` maps repo → workspace(s). Today the handler stamps `mergedAt`, auto-completes tasks, and triggers releases — it does zero knowledge work.

**Add:** on merged PR (any repo with a bound workspace, not just worker PRs), enqueue an ingest job.

### 3.2 `knowledge_ingest_jobs` table (new)

```
id uuid PK, workspace_id uuid FK, repo text, trigger text ('pr_merged'|'backfill'|'manual'|'scheduled'),
sha text, pr_number int, scope text ('diff'|'full'), status text ('queued'|'running'|'done'|'error'),
changed_files jsonb, stats jsonb, error text, created_at, started_at, finished_at
```

One queue for both incremental and full runs; idempotent (unique partial index on `(workspace_id, sha, scope)` where status != 'error'). Powers the health UI (§6.3) and retry.

### 3.3 Two execution paths by job size

**Diff jobs (the common case) run serverless.** For a merged PR: list changed files via the GitHub API (installation token, already available in the webhook — payload HMAC-verified upstream), fetch blob contents at the merge SHA via the contents API — **no checkout needed** — chunk + upsert via the existing `fileToChunks`/`PgVectorStore.upsert`, `deleteBySource` for removed/renamed paths. Apply the same skip filters as `ingest-knowledge.ts` (tests, migrations, lockfiles, generated dirs, binaries). Cap at 100 files / 2 MB fetched per job; larger diffs escalate to a `full` job. Execute via `waitUntil` after the webhook 200s; if that proves flaky, flip to a self-invoked internal route — the jobs table makes either transport idempotent and retryable.

Existing `_markSuperseded` fires on these upserts — **this alone delivers old→new replacement for code**: pre-merge chunks for a changed file are marked `is_current=false, superseded_by=<new>` automatically.

**Full jobs run on the runner fleet.** Backfill (first index of a workspace), escalated large diffs, and weekly re-syncs need a checkout. Reuse the worker rail: a system task (`roleSlug: 'ingest'`, hidden from the normal task UI) claimed by any runner with repo access, executing `ingest-knowledge.ts` against its checkout. Runners already hold clones and credentials. Fallback for repos without runners: a reusable GitHub Action (`buildd-ai/knowledge-ingest-action`) — same script, `BUILDD_API_KEY` secret.

### 3.4 First-index backfill

On webhook receipt (or workspace↔repo binding), if `listNamespaces` shows no `{workspaceId}:code` namespace, enqueue a `full` backfill job. This retires the #1159 "run ingestion first" dead end.

### 3.5 PR diff corpus

Beyond the existing summary card (`buildPrCard`, no diffs), ingest the patch itself: per-file hunks chunked into corpus `pr`, `source_id = pr:{n}#{path}`, metadata `{prNumber, taskId?, missionId?}`. Authority stays 0.5, half-life 45d. This is what makes "how did we change auth last month?" answerable with actual code deltas, and gives edge-builder `produced` edges real file lists.

**Acceptance (Phase A):** merging a PR in any bound repo updates that workspace's `code` corpus within minutes; `query_knowledge corpus:code` returns post-merge content and no superseded chunks; a fresh workspace gets a full index without any human action; `knowledge_ingest_jobs` reflects every run.

---

## 4. Phase B — Code-structure layer (AST + SCIP)

Implements §9 of `knowledge-graph-retrieval.md`, adapted to the Phase A split:

- **ast-grep (`@ast-grep/napi`) in the ingest path.** No build required, stateless, fast. **Risk:** it's a native napi binary — fine in Bun scripts, runner jobs, and CI, but must be loaded via dynamic `import()` with graceful fallback to the line-window splitter wherever it's unavailable (notably the Vercel serverless diff path, where the platform-specific binary may not bundle). Symbol-quality chunks are an enhancement, never a dependency. Two uses:
  1. **Symbol-boundary chunking** — replace the line-window splitter for supported languages: chunks align to function/class/export boundaries (fall back to line-window). Better retrieval units at zero pipeline cost.
  2. **Symbol entity extraction** — top-level exports/classes/functions → `knowledge_entities(kind='symbol')` + `(file, defines, symbol)` edges; import statements → `(file, imports, file)` edges (path-resolved, best-effort).
- **scip-typescript in runner full jobs only.** Needs an installable project — runners have one. Emits canonical monikers → precise `defines`/`references`/`imports` edges + alias seeding (`entity_aliases.source='scip'`, already in the schema). Cache by SHA; skip if unchanged. Graceful degradation: SCIP failure leaves ast-grep edges in place.
- **Entity catalog injection (§8.4, unshipped).** At claim time, alongside `buildKnowledgeContext`: resolve the task's likely files (mission context, task description paths) → their symbol entities → inject a compact "known entities" list. Agents then reference real names; `pending_entity_refs` stops accumulating junk.

**Acceptance:** after ingesting a TS repo, `query_knowledge` on a symbol name returns its defining chunk first; graph expansion surfaces the spec/doc chunk linked via `implements`/`references_doc`; ≥80% of agent-written entity refs auto-bind (measure via `entityBinding` stats).

---

## 5. Phase C — Semantic supersession + consolidation

- **Entity-keyed supersession (deterministic).** Extend `_markSuperseded`: when a new chunk's resolved entity set (`role='defines'`) matches an older chunk's in the same namespace, and corpus authority is ≥ and `source_ts` newer, supersede. This catches "new design doc replaces old one under a different filename" and re-worked memories.
- **Wire the `supersedes` param.** `UpsertChunk.supersedes` exists in types but is unwired; plumb it through `complete_task` / `buildd_memory save` per the §8 MCP contract so agents can assert replacement explicitly (response already specs `entityBinding` feedback).
- **Scheduled consolidation task (LLM allowed — it's an agent, not the pipeline).** A weekly system task per active workspace, run by an agent with a tight prompt:
  1. Query near-duplicate pairs (embedding cosine > 0.92 within `memory`/`task` corpora, both `is_current`).
  2. Merge: update the survivor via the memory service (source of truth), mark the loser superseded in the chunk store.
  3. Archive decayed noise: `task`/`artifact` chunks past 6× half-life with zero retrieval hits → `is_current=false` (audit-recoverable via `history:true`; nothing is deleted).
  4. Emit a consolidation report artifact (what merged, what archived) — itself indexed.

  Retrieval-hit tracking needs one addition: increment a `hit_count`/`last_hit_at` on chunks returned by `query_knowledge` (cheap fire-and-forget UPDATE).

**Acceptance:** duplicate-memory rate trends down (measure pre/post with `assess-knowledge.ts`); a superseded design doc no longer appears in default retrieval; consolidation runs leave an auditable artifact.

---

## 6. Phase D — Distillation & surfacing

1. **`session` corpus goes live.** On worker completion, the runner posts a structured session summary (what was tried, what failed, key decisions — distinct from the task-outcome card) → corpus `session`, authority 0.2, half-life 7d. Cheap, and exactly what claim-time injection needs for "another agent touched this yesterday."
2. **Weekly workspace digest.** Scheduled agent task: synthesize the week's merged PRs / completed tasks / new memories into a digest artifact (`type=summary`) — indexed like any artifact, and human-readable in the dashboard.
3. **Knowledge health UI.** Workspace settings panel backed by `knowledge_ingest_jobs` + namespace stats: chunks per corpus, last ingest SHA/time vs. repo HEAD, pending entity refs, index-freshness warning. Makes "is my knowledge current?" a glance instead of a debugging session.
4. **Eval in CI.** `assess-knowledge.ts` (recall@k + MRR) already exists; run it post-ingest for the buildd workspace and fail loudly on regression >20%.

---

## 7. Rollout — work streams

Three streams are **independent at the file level** and start immediately, in parallel. The rest sequence behind them.

### Wave 1 (shipped: A1 → #1180, B1 → #1179, C1 → #1181)

| Stream | Scope | Files touched | Ships as |
|---|---|---|---|
| **A1** ingest queue + webhook + diff ingester | `knowledge_ingest_jobs` schema + migration; enqueue on merged PR; serverless diff ingest via contents API; backfill enqueue on empty `{workspaceId}:code` namespace | `packages/core/db/schema.ts` + migration, `apps/web/src/app/api/github/webhook/route.ts`, new `apps/web/src/lib/knowledge-ingest.ts` | 1 PR |
| **B1** ast-grep symbol layer | symbol-boundary chunking (dynamic-import + line-window fallback); symbol entities + `defines`/`imports` edges | `packages/core/knowledge-store/{chunker,entity-extractor,edge-builder,ingest}.ts`, new `symbol-extractor.ts` | 1 PR |
| **C1** explicit + entity-keyed supersession | wire `UpsertChunk.supersedes` through `complete_task`/`buildd_memory save`; entity-keyed `_markSuperseded` extension | `packages/core/mcp-tools.ts`, `packages/core/knowledge-store/pg-vector-store.ts` | 1 PR |

Only A1 carries a migration — no migration conflicts across the wave. B1 and C1 both touch `knowledge-store/types.ts` additively (trivial merge).

### Wave 2 (parallel, in flight)

| Stream | Depends on | Status |
|---|---|---|
| A2 runner full jobs + backfill executor + CI fallback script | A1 (jobs table) | In flight (with A3, 1 PR) |
| A3 PR-diff corpus | A1 | In flight (with A2) |
| B2a entity catalog injection at claim | B1 | In flight |
| C2 consolidation plumbing + hit tracking (`hit_count`/`last_hit_at` migration) | C1 | In flight |

### Wave 3 (sequenced)

| Stream | Depends on |
|---|---|
| B2b SCIP in runner full jobs | A2, B1 |
| D session corpus, weekly digest, health UI, CI eval | A1 for UI; others independent |

Each stream is independently shippable and abandonable, consistent with the Layer 1–3 precedent.

## 8. Storage decision — Postgres index, R2 blobs

Knowledge lives **in the core buildd Postgres** (`knowledge_chunks` + entity/edge tables, same Neon DB as tasks/workers), not a separate store. The only external system is the memory service (source of truth for hand-written memories, mirrored in). This stays.

**Why not R2 (or another store) for the index:** retrieval is a query engine — HNSW ANN + BM25 + RRF fusion + entity/edge joins per query. Object storage can't serve any of that; moving the index means adopting a vector DB, not R2. The `KnowledgeStore` interface is deliberately swappable, so that door stays open with zero call-site churn.

**Where R2 (already connected) does fit — blobs, not indexes:**
- SCIP index files from runner jobs (B2) — fetch, parse, discard; never in PG
- Full PR diffs beyond the chunked hunks (A3) — chunk what's retrievable, R2 the raw patch, `source_url` points at it
- Raw session transcripts behind `session`-corpus summaries (D1)

**Cost reality:** the marginal row cost is the 1024-dim vector (~4 KB + ~2× HNSW overhead) — even 100k chunks is low-single-digit GB on Neon, i.e. noise. Actual spend is Voyage embedding at ingest and rerank at query, both usage-based and small at single-team scale (backfill spend control is Q2 below). Revisit a dedicated vector backend only at millions of vectors per namespace or if Neon compute becomes the bottleneck — neither is on the horizon.

## 9. Open questions

1. **Multi-workspace repos** — if two workspaces bind the same repo, ingest into both namespaces (duplicate embedding cost) or introduce shared repo-level namespaces with per-workspace ACL? Default: duplicate; revisit if cost shows up.
2. **Embedding spend control** — per-team monthly embedding budget in `knowledge_ingest_jobs` accounting? Voyage cost at diff-scale is trivial, but full backfills of large repos are not. Propose a soft cap + alert, no hard block initially.
3. **Non-TS languages** — ast-grep covers most; SCIP equivalents (scip-python etc.) deferred until a workspace needs one.
4. **Serverless time budget** — if contents-API diff ingest breaches Vercel limits in practice, drop the serverless path entirely and route all jobs to runners (the jobs table makes this a config change, not a redesign).
