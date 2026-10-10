---
title: Pluggable Knowledge Store
status: draft
owner: max
last_verified: 2026-10-10
summary: The knowledge store MUST separate a buildd-owned ranking pipeline from a swappable index backend, keep pgvector the default and hosted backend until measured triggers fire, and never export sensitive-workspace content to an external index.
domain: knowledge
surfaces: [packages/core/knowledge-store/pg-vector-store.ts, packages/core/knowledge-store/types.ts, packages/core/mcp-tools.ts, packages/core/eval/retrieval-baseline.json]
related: [knowledge-store-retrieval, knowledge-ingest-pipeline, byo-evidence-storage]
keywords: [turbopuffer, pgvector, index backend, dual-write, shadow read, outbox, dataClass, iterative_scan, recall@40, KNOWLEDGE_STORE]
supersedes: []
---
# Pluggable Knowledge Store

**Capability statement**: Buildd MUST own retrieval quality (embedding, fusion,
graph expansion, rerank, freshness, hit accounting) in one pipeline, and MUST
treat the row/ANN/lexical index underneath it as a replaceable, rebuildable
backend whose default is Postgres with pgvector.

## Status and authority

This spec is `draft`. It becomes `active` only when the Phase 0 and Phase 1
guards in "Test and contract matrix" exist and are named in `verified_by`
(SPEC-FORMAT rule 9). No phase below is approved for execution by merging this
document: each phase needs an explicit owner approval (see "Human-review
questions").

Two sources feed it, and they are not equal:

- **Normative**: this file, once merged. Where it conflicts with the design
  below, this file wins.
- **Exploratory prior design**: `knowledge-base: buildd/design/pluggable-knowledge-store.md`
  (Status: Proposed, 2026-10-05). Its measurements are a 2026-10-05 snapshot,
  were taken read-only against production, and were NOT re-measured when this
  spec was written. They are labelled **[snapshot]** below. Recon of the code
  on `dev` (HEAD `1ec08918c`, 2026-10-10) is in the mission artifact
  "Recon: KnowledgeStore as-built audit vs. Oct 2026 pluggable-backend draft".

Relationship to siblings: `knowledge-store-retrieval` stays the behavioural
contract for the current `PgVectorStore`; this spec is additive and sets no
`supersedes`. Where the two disagree on as-built facts, section "As-is
inventory" is correct and the retrieval spec is stale (row S1-S4 there).

---

## 1. Problem, outcomes, non-goals

**Problems (all verified in code on 2026-10-10)**

- P1. Ranking is not a single behaviour. `PgVectorStore` is constructed 33
  times in non-test code with `(embedder|null, reranker|null)`, so whether
  recency decay applies depends on the call site: a configured reranker
  overwrites it in `_finalize` (`types.ts` `recencyAuthority` doc;
  `pg-vector-store.ts:680`).
- P2. About a dozen production modules read or write `knowledge_chunks`
  directly, bypassing the store (list in section 2.2).
- P3. Deletion leaks: `memory_delete` discards an index-delete failure
  (`packages/core/mcp-tools.ts:8559`, `.catch(() => {})`), and workspace delete
  (`apps/web/src/app/api/workspaces/[id]/route.ts:556`) and team delete
  (`apps/web/src/app/api/teams/[id]/route.ts:351`) purge no chunks.
- P4. The hybrid quality gate cannot fail on a dead vector leg: the committed
  baseline is `"pipeline": "bm25-lexical-only-no-voyage-key"`
  (`packages/core/eval/retrieval-baseline.json`) and
  `.github/workflows/knowledge-eval.yml` only warns when `VOYAGE_API_KEY` is
  absent.
- P5. Vector recall at scale is unverified in CI: `_vectorSearch`
  (`pg-vector-store.ts:807`) is a plain `ORDER BY embedding <=> ... LIMIT`; no
  `hnsw.iterative_scan` or `hnsw.ef_search` setting exists in the repo.
  **[snapshot]** recall@40 against exact search was materially lower on the
  largest code namespace than on pr / docs namespaces, and improved with
  `iterative_scan = relaxed_order` without reaching parity; the sample was
  small and self-embedded, so optimistic. Figures live in the private knowledge base.
- P6. There is no hybrid p50/p95/p99 anywhere, so no latency trigger can be
  evaluated.

**Outcomes**

- O1. One ranking pipeline; identical scoring on every backend.
- O2. Backend chosen once per process by configuration; unset means today's
  behaviour byte for byte.
- O3. Deletes and purges are durable and observable.
- O4. A gate that fails when the vector leg is disabled.
- O5. Evidence (latency, recall, cost) sufficient to make an adopt/decline
  decision on an external index without guessing.

**Non-goals**

- NG1. Moving Buildd hosted off pgvector. Hosted stays on pgvector until a
  trigger in section 9 fires.
- NG2. Activating any paid vendor plan, including a low minimum, because it is
  cheap. Cost is not the problem being solved.
- NG3. Moving the entity graph, hit ledger, `memories`, ingest-job leases or
  ACL into a vendor index. They stay in Postgres.
- NG4. Replacing Voyage models, changing chunking, or changing the MCP
  `query_knowledge` contract.
- NG5. Any schema, runtime or infra change in the PR that merges this spec.

---

## 2. As-is inventory vs proposed

### 2.1 Backend surface today

| Concern | As-is (source) | Proposed |
|---|---|---|
| Interface | `KnowledgeStore` in `packages/core/knowledge-store/types.ts`: upsert/query/delete/listNamespaces plus optional `countNamespace`, `markSupersededByEntities`, `deleteBySource`, `getFileHashes`, `touchBySource`, `listSourcePaths`, `nearDupeCheck` | Keep as the public facade; implement it with pipeline + backend |
| Construction | 33 non-test `new PgVectorStore(...)` (runner `knowledge-ingest.ts` 3; `apps/web` `api/chat/[id]`, `api/mcp`, `api/mcp-oauth`, `workers/claim/context-injection.ts`, `lib/evidence-indexer.ts`, `lib/knowledge-context.ts`, `lib/knowledge-ingest-batch.ts`, `lib/knowledge-ingest.ts`, `lib/memory-helper.ts`; `packages/core` `mcp-tools.ts` 4, `memory-retrieval.ts`, `manifest-prediction-source.ts`, `spec-discrepancy-intake.ts`, `task-size-estimate.ts`; 9 scripts) | One factory (`getKnowledgeStore`); no direct construction outside it and tests |
| Fusion | `reciprocalRankFusion` k=60, `pg-vector-store.ts:118` | Moves to the pipeline, unchanged |
| Lexical leg | `ts_rank` over stored generated `lexical_tsv`, GIN index (`buildLexicalSearchSql` `:94`, schema `knowledgeChunks.lexicalTsv`; shipped in #3019, #3016 was closed unmerged). This is NOT BM25 (no IDF or length normalisation) | Document honestly as `ts_rank`; real BM25 is a backend capability, not a pgvector promise |
| Vector leg | HNSW cosine, single global index `knowledge_chunks_embedding_hnsw_idx` (`drizzle/0000_baseline.sql`) | Same, plus Phase 0a recall settings |
| Embedder | `_selectEmbedder` (`pg-vector-store.ts:187`): code/docs/spec -> `voyage-code-3`, other corpora -> `voyage-4-large`, both 1024-d; reranker `rerank-2.5` | Pipeline owns embedding; backend stores vectors it is handed |
| Graph | PG tables `knowledgeEntities`, `entityAliases`, `chunkEntities`, `knowledgeEdges` (`schema.ts:3714-3765`); `_graphExpand` `:446`; no FK to chunks | Stays in PG; neighbour chunks fetched through backend `get` |
| Supersession | path-keyed `_markSuperseded` `:547`, explicit `:575`, entity-keyed `markSupersededByEntities` `:615`, memory raw UPDATE `memory-lifecycle.ts:274`, near-dupe bands in `learn` | Policy in the pipeline, mutation via backend `patch` |
| Hits | `hit_count`/`last_hit_at` UPDATE fire-and-forget in `query` (`:415-430`); separate `memory_uses` ledger | Hits written to a Postgres ledger on every backend |
| Isolation | namespace string `{id}:{corpus}`; every query is `WHERE namespace = $ns`; memory is team-wide `{teamId}:memory` with per-project filtering in the app after retrieval (`memory-retrieval.ts`) | Unchanged; the backend contract makes namespace mandatory |
| Batch upsert | `upsert` loops per chunk (`:207`) | Batch with per-id status |
| Telemetry | none for hybrid timing | `knowledge_query` stage timings (embed, vector, lexical, fuse, rerank, graph) |

### 2.2 Direct `knowledge_chunks` access outside the store

Production modules (read/write/delete classification is a Phase 1 first step;
some hits are comments): `packages/core/memory-retrieval.ts`,
`memory-lifecycle.ts:274`, `memory-index-reconcile.ts`,
`task-area-prediction-source.ts:212`, `manifest-prediction-source.ts:257`,
`retrieval-clusters.ts`, `knowledge-store/consolidation.ts`,
`knowledge-store/health.ts:151`, `apps/web/src/lib/knowledge-ingest-batch.ts:136`,
`knowledge-context.ts`, `post-session-store.ts`, `packages/core/billing-limits.ts`,
`apps/web/src/app/api/admin/backfill-entity-graph/route.ts`. Operational
scripts (reset, backfill, assess, dedup, audit, migrate) MAY stay
Postgres-specific.

---

## 3. Decision records

### ADR-1 Stay on pgvector only (status quo)
- For: zero new failure modes; one transactionally consistent store; hosted
  figures **[snapshot, in the private knowledge base]** (chunk count, largest
  namespace, index size) are orders of magnitude under the triggers in section 9.
- Against: leaves P1-P4 unfixed; no portability for deployments that must use
  another index; the recall defect P5 remains.
- Verdict: insufficient alone. P1-P6 are defects regardless of vendor.

### ADR-2 Pluggable backend, pgvector default (CHOSEN direction)
- Do Phases 0a-0c (defect fixes, independent of any vendor) and Phase 1 (pipeline
  and backend split). This passes the portability test with no vendor in
  the picture and makes any later comparison fair because scoring is identical.
- Cost: a medium refactor touching 33 constructions and about a dozen raw-SQL
  modules.

### ADR-3 Turbopuffer (or any external index) now for hosted
- Verdict: NOT NOW. Usage would sit under the vendor's lowest monthly minimum
  **[snapshot; vendor pricing fetched 2026-10-05, re-verify before citing]**,
  hosted corpus is small, and an external index adds a network hop to graph
  expansion plus a dual-write consistency burden. It is reconsidered only
  through Phases 2-4 and the triggers in section 9.
- A provider adapter (Phase 2) is justified by an enterprise or self-hosted
  need or a scale trigger, not by price.

---

## 4. Buildd-owned pipeline and backend interface

**Invariants**
- I-1. The pipeline owns: query embedding, candidate fusion (RRF k=60), memory
  scope post-filter, graph expansion, rerank, recency x authority, hit
  recording, supersession policy, `topK` cap of 50, rerank pool of
  `min(topK*5, 100)`.
- I-2. The backend owns only: stored rows, ANN, lexical search, id lookup,
  field patch, delete, scan, count, namespace listing and deletion.
- I-3. The backend interface MUST declare a capabilities object:
  `lexicalKind` (`ts_rank` | `bm25`), `strongRead` (boolean), `filterOps`,
  `maxBatch`, `maxTopK`. The pipeline MUST adapt to capabilities, never to a
  backend name.
- I-4. Backend primitives (names are proposals; the Phase 1 PR fixes them):
  `upsertRows(ns, rows)` returning per-id status; `ann(ns, vector, k, filter)`;
  `lexical(ns, text, k, filter)`; `get(ns, ids, fields)`; `patch(ns, id, fields)`;
  `delete(ns, ids)`; `deleteByFilter(ns, filter)`; `scan(ns, filter, cursor)`;
  `count(ns)`; `listNamespaces(scope)`; `deleteNamespace(ns)`.
- I-5. Filters every backend MUST support: namespace (mandatory), corpus,
  sourceType, `is_current`, `source_ts` before a cutoff, id exclusion. The last
  two are `sourceTsBefore` and `exclude` query params, absent today.
- I-6. One factory, selected by `KNOWLEDGE_STORE` (`pgvector` default,
  `turbopuffer` optional). Unset or `pgvector` MUST behave exactly as today.
  The backend is chosen once per process; no per-request switching.
- I-7. Must-stay-in-Postgres set: entity graph tables, hit ledger
  (`memory_uses`, `memory_decisions`), `memories`, `knowledgeIngestJobs`,
  evidence rows, workspace `dataClass`, team ACL, and the delete/dual-write
  outbox. The index is derived and rebuildable from these plus source content.

**Acceptance criteria**
- AC-1: GIVEN the factory with `KNOWLEDGE_STORE` unset WHEN a query runs THEN
  results equal the current `PgVectorStore.query` on the golden set (rank order
  and scores within 1e-6).
- AC-2: GIVEN a lint check WHEN it scans non-test code THEN no file outside the
  factory and its backend constructs `PgVectorStore`, and no file outside the
  pgvector backend and scripts issues SQL against `knowledge_chunks`.
- AC-3: GIVEN two call sites, one with a reranker configured and one without
  WHEN the same query is run THEN recency and authority are applied identically
  (the P1 defect is gone).
- AC-4: GIVEN `KNOWLEDGE_STORE=unknown` WHEN the process starts THEN it fails
  fast with an error naming the valid values; it MUST NOT fall back silently.

---

## 5. Isolation, dataClass, ACL and export rules

**Invariants**
- X-1. Namespace is the isolation primitive on every backend. A backend call
  without a namespace MUST be rejected.
- X-2. Per-user and per-project ACL stays an application post-filter. The
  over-fetch factor for memory scope MUST be recalibrated, and measured, per
  backend before that backend serves memory.
- X-3. An external backend MUST NOT receive any chunk from a workspace whose
  `workspaces.dataClass` is `sensitive`. Enforcement is at the write path, in
  the factory-level wrapper, not in each ingester.
- X-4. Today sensitive gating exists at read (`SENSITIVE_WITHHELD_CORPORA` =
  memory, initiative, evidence; `packages/core/mcp-tools.ts:745`, enforced at
  `:7797`) and at memory/evidence write. A grep of `knowledge-ingest*.ts`,
  runner ingest and ingest routes found no `dataClass` reference, so
  code/docs/pr/task/artifact/session chunks of a sensitive workspace are
  indexed. That is harmless inside one Postgres and an export violation on an
  external one. This was found by grep only and is to be confirmed by test
  (Phase 0b/2 guard).
- X-5. Export to an external index requires: the X-3 guard, outbox-driven
  deletion (section 6), a documented physical-deletion and retention behaviour
  for the vendor, and an owner-approved DPA/subprocessor review.
- X-6. `spec_compare` stays admin-only and its namespace override MUST NOT be
  usable to read another tenant's namespace through an external backend.

**Acceptance criteria**
- AC-5: GIVEN a sensitive workspace WHEN any ingest path (MCP mirror, diff
  executor, runner job, evidence indexer) writes through an external-backend
  wrapper THEN zero rows reach the backend and a counted skip is logged.
- AC-6: GIVEN workspace A and B on one backend WHEN A queries with B's
  namespace string THEN the call is rejected by the caller's authorisation
  before reaching the backend.
- AC-7: GIVEN a workspace flips from standard to sensitive WHEN the flip is
  processed THEN its rows are removed from any external backend by the outbox.

---

## 6. Lifecycle consistency

**Invariants**
- L-1 Idempotence: upsert is keyed by `(namespace, source_id)` with
  `content_hash` as the write fence; replaying any write yields the same state.
- L-2 Dual writes: Postgres (source of truth, outbox row) is written first; the
  external write is driven from the outbox and retried with backoff. There is
  no interactive `db.transaction` on the neon-http driver, so atomicity is
  never assumed; reconciliation by `scan` repairs drift.
- L-3 Delete: every delete (single, by source, sweep, memory, workspace, team)
  enqueues an outbox row and MUST NOT be swallowed. A failure leaves the row
  pending and visible, never `.catch(() => {})`.
- L-4 Purge: workspace and team deletion MUST call `deleteNamespace` for every
  corpus namespace and remove dependent `chunk_entities`/edges. A reconcile job
  reports orphans (namespace with no owning workspace or team).
- L-5 Rename/move: a source path change is delete-old plus upsert-new in one
  outbox batch; no window where both are `is_current`.
- L-6 Supersession: policy computed in the pipeline; `patch` applies it.
  Within the freshness window after a patch, reads of superseded rows use a
  strong read when `strongRead` is true; otherwise the pipeline filters by
  `is_current` from a Postgres-side marker.
- L-7 Embedding space: a vector is only comparable inside its model. Rows
  written by an earlier model (June `voyage-4-large` code/docs rows
  **[snapshot]**) MUST be purged and re-embedded, never migrated by copy.
- L-8 Migration: backfill is resumable, namespace by namespace, and verifiable
  by count and content-hash comparison before any read cutover.
- L-9 Rollback: switching `KNOWLEDGE_STORE` back to `pgvector` MUST restore
  full service with no data loss, because Postgres stays complete through
  Phases 2-3.
- L-10 Failure: an external backend outage degrades to the pgvector path when
  configured as shadow, and fails the request visibly when configured as
  primary; it never returns silently empty results.

**Acceptance criteria**
- AC-8: GIVEN `memory_delete` and an index-delete failure WHEN the call returns
  THEN an outbox row is pending and the failure is observable (log + metric).
- AC-9: GIVEN a workspace deletion WHEN it completes THEN no row remains in any
  of its namespaces and no `chunk_entities` row references them.
- AC-10: GIVEN the same upsert replayed three times WHEN counted THEN exactly
  one row exists and `content_hash` is unchanged.
- AC-11: GIVEN a simulated external outage in shadow mode WHEN queries run THEN
  responses come from pgvector and the divergence counter increments.
- AC-12: GIVEN rollback to `pgvector` after a dual-write period WHEN the golden
  set runs THEN results equal the pre-dual-write results.

---

## 7. Code, docs, spec and memory graph; Voyage models

- Corpora in scope: `memory`, `code`, `docs`, `spec`, `task`, `artifact`, `pr`,
  `plan`, `session`, `initiative`, `evidence` (`Corpus` in `types.ts:34-45`;
  note the schema `$type` omits `evidence`, a type-only drift to fix in Phase 1).
- Voyage: the pipeline selects the embedder per corpus exactly as
  `_selectEmbedder` does today; a backend declares the dimension it stores
  (1024) and rejects other sizes. With no `VOYAGE_API_KEY` the system keeps its
  lexical-only mode; the quality gate (section 10) however MUST NOT run in that
  mode.
- Graph equality: `useGraph` expansion MUST return the same neighbour set on
  every backend, because the PG lookup is unchanged and only the final `get`
  differs. Expansion is bounded by the existing limits and batched to one
  backend round trip.
- Supersession equality: given the same write history, `is_current` and
  `superseded_by` MUST be identical across backends.
- `consolidation.ts` self-joins embeddings in SQL; it is Postgres-only until a
  `scan` primitive replaces it. It MUST be declared unsupported on an external
  primary rather than silently skipped.

---

## 8. Deployment, keys, residency, cost

- **Hosted (buildd.dev)**: pgvector on the existing Neon database. No
  keep-alive pings; no plan changes driven by this spec.
- **Self-hosted / enterprise**: pgvector is the default and sufficient. The
  deployer needs pgvector >= 0.8 for Phase 0a settings; below that, use
  per-corpus partial indexes or exact scan under about 50k rows. An optional
  external index is a deployer choice documented per deployment, not a hosted
  default.
- **Env-key policy**: the external index key is an instance environment variable
  (for example `TURBOPUFFER_API_KEY`), never a `secrets` row, because
  CLAUDE.md scopes `secrets` to agent-backend credentials. This is a deliberate
  exception and is Human-review question Q1. The key is never logged, never
  sent to a worker sandbox, and absent keys leave the pgvector default
  untouched.
- **Data residency and plan constraints**: before adoption record, per
  deployment, the vendor region, whether private networking, customer-managed
  keys, BYOC or single-tenancy are needed, and which plan tier includes them.
  **[snapshot]** those controls were Enterprise-tier and SOC2/DPA were on the
  lowest paid tier; vendor docs were fetched on 2026-10-05 and MUST be
  re-fetched by whoever acts on this.
- **Latency and cost assumptions (all [snapshot], none measured end to end)**:
  server-side EXPLAIN on the largest namespace showed each leg in the hundreds
  of milliseconds, cold-ish; no hybrid percentiles exist (P6). Cost
  estimates of a few dollars per month for an external index at current size
  rest partly on a third-party price capture and are rough, not measured.
  Phase 0 telemetry replaces these with measured values before any trigger is
  evaluated.

---

## 9. Go/no-go triggers

Hosted stays on pgvector unless ANY ONE holds, measured over 7 consecutive
days after Phase 0a and the Phase 0 telemetry exist:

- T1. total chunks > 5,000,000, or any namespace > 1,000,000 rows;
- T2. claim-path knowledge query p95 > 1 s with `iterative_scan` enabled;
- T3. knowledge-attributable database cost > about 50 USD per month;
- T4. a contracted customer requires per-namespace customer-managed keys;
- T5. recall@40 on the largest namespace < 0.95 after Phase 0a and no
  pgvector-side remedy (partial indexes, tuning) restores it.

An external adapter MAY be built (Phase 2) when: an enterprise or self-hosted
deployer already contracts the vendor, or the corpus is about 10M+ chunks, and
all of these hold: X-3 guard tested, Phase 0b closed, no raw SQL outside the
backend (AC-2), key outside `secrets`.

NO-GO, independent of price: a sensitive workspace can be indexed without a
gate; any consumer still issues raw SQL against `knowledge_chunks`; deletion is
swallowed.

Adoption on hosted (Phase 4) additionally needs the shadow report to show:
top-10 overlap >= 0.9 versus pgvector on the golden set, recall@40 >=
pgvector, p95 not worse, zero isolation or deletion violations, and a written
cost comparison from measured workload, not list prices.

---

## 10. Test and contract matrix

Contract tests run the same cases against every backend. Real Postgres is
required for pgvector cases (the current store tests use a mocked database).

| ID | Contract | Case | Phase | Gate |
|---|---|---|---|---|
| M1 | Hybrid-quality baseline | Eval with Voyage enabled; baseline pipeline recorded as hybrid; metrics within threshold | 0c | CI |
| M2 | Vector-disabled fails gate | Run the eval with the vector leg disabled or key absent; gate MUST fail, not warn or exit 0 | 0c | CI |
| M3 | ANN recall@10 and @40 | Compare ANN to exact search on real PG, per namespace size band, with `iterative_scan` and `ef_search` set; threshold >= 0.95 at 40 | 0a | script + CI |
| M4 | Lexical | Assert lexical kind: `ts_rank` on pgvector, `bm25` on a backend declaring it; ranking sanity on golden terms | 0c/1 | CI |
| M5 | RRF + rerank + freshness | Fixed candidates produce fixed fused order; recency x authority identical with and without a reranker (AC-3) | 1 | unit |
| M6 | Graph equality | Same writes; `useGraph` neighbour sets equal across backends | 1/2 | contract |
| M7 | Supersession equality | Path, entity and explicit supersession yield identical `is_current` | 1/2 | contract |
| M8 | Data isolation | Cross-namespace and cross-workspace reads return nothing (AC-6) | 1/2 | contract |
| M9 | dataClass export | Sensitive workspace writes never reach an external backend (AC-5) | 0b/2 | contract |
| M10 | Deletion and purge | AC-8, AC-9, workspace and team delete, orphan report | 0b | integration |
| M11 | Idempotence | AC-10 | 1 | contract |
| M12 | Rollback | AC-12 | 3 | integration |
| M13 | Shadow read correctness | Top-10 overlap and rank correlation vs primary; divergences logged by reason | 3 | report |
| M14 | Latency | p50/p95/p99 per stage and end to end, cold and warm, per backend | 0 (telemetry), 3 | report |
| M15 | Workload cost | Query, write and storage volumes from telemetry multiplied by vendor price at the time; no list-price guessing | 3/4 | report |
| M16 | Telemetry | `knowledge_query` records stage timings, backend id, result counts, divergence | 0 | unit |
| M17 | Default unchanged | AC-1 and AC-4 | 1 | unit |

Commands: `bun run scripts/run-unit-tests.ts <file>` for unit files,
`bun run test` for the suite (run with an extended timeout, several minutes),
`bun run eval:retrieval <workspaceId> --output packages/core/eval/retrieval-baseline.json`
to regenerate the baseline, `bun run specs:check` after editing any spec.

---

## 11. Phase plan

Phases 0a, 0b and 0c are independent of each other and of everything after
them; each becomes its own task. Each phase needs explicit owner approval.

| Phase | Outputs | Likely source paths | Depends on | Verification | Exit condition |
|---|---|---|---|---|---|
| 0a Recall settings | `hnsw.iterative_scan = relaxed_order` and `hnsw.ef_search >= 100` applied per query (per-transaction setting), re-sort by distance; a repeatable fidelity script; real-PG test | `pg-vector-store.ts` (`_vectorSearch`), `packages/core/scripts/` (new), `apps/web/tests/db/` | none | M3 | recall@40 >= 0.95 on every size band, or the shortfall documented with a remedy |
| 0b Delete hygiene | Postgres outbox for index deletes; workspace and team delete purge; `memory_delete` no longer swallows; orphan report; sensitive-workspace ingest gate; schema change goes through the schema-change skill | `mcp-tools.ts`, `workspaces/[id]/route.ts`, `teams/[id]/route.ts`, `knowledge-ingest*.ts`, `schema.ts` + migration | none (migration is its own approved step) | M9, M10 | AC-8, AC-9 pass; no orphan namespace |
| 0c Hybrid gate | Baseline regenerated with Voyage enabled; workflow fails (not warns) without the key or with the vector leg off; paths filter and migration skip reviewed | `knowledge-eval.yml`, `eval/regression.ts`, `eval/retrieval-baseline.json` | none | M1, M2 | a deliberately vector-disabled run fails CI |
| 1 Portability refactor | pipeline and backend split; pgvector backend; factory; replace 33 constructions; move raw-SQL modules behind store methods; batch upsert; hits to Postgres ledger; `sourceTsBefore`/`exclude`; stage telemetry | `knowledge-store/` (new files), the call sites in section 2.1, section 2.2 modules | 0a, 0b, 0c (so equality is measured against a trusted baseline) | M5, M6, M7, M8, M11, M16, M17, lint AC-2 | golden tests unchanged; lint AC-2 green; default behaviour identical (AC-1) |
| 2 Optional provider | external backend behind `KNOWLEDGE_STORE`; key as instance env var; capability declaration; dataClass guard in wrapper; contract suite on per-test namespaces | `knowledge-store/` backend file, factory | 1; an approved need per section 9 | M3-M11 on both backends | contract suite green on both; fidelity >= pgvector; no key needed when unset |
| 3 Shadow | time-boxed (2-4 weeks) opt-in dual-write and shadow read on a named non-customer workspace; outbox-driven; divergence report | outbox worker, shadow wrapper | 2; owner approval for any paid plan | M12-M15 | report in the knowledge base; flag off restores pgvector-only |
| 4 Decision | evidence-backed adopt/decline recorded in this spec; status updated | this file | 3 | section 9 criteria | decision recorded; hosted unchanged unless a trigger fired |

No phase after 1 starts automatically. This spec PR is the stopping point.

---

## 12. Human-review questions

- Q1. Env var vs `secrets` row for an external index key: this spec chooses an
  instance env var (CLAUDE.md scopes `secrets` to agent backends). Confirm the
  exception.
- Q2. Hit tracking in a Postgres ledger on every backend, retiring
  `hit_count`/`last_hit_at` writes from the index. Lean yes; confirm.
- Q3. Should memory scope filtering be pushed down to a backend filter? Lean no
  (post-filter in the app); confirm.
- Q4. Vendor physical-deletion retention window acceptable for customer data?
  Needed before any Phase 3 content leaves Postgres.
- Q5. For the enterprise deployment, is pgvector >= 0.8 on the target
  Postgres available?
- Q6. Is the sensitive-workspace ingest gap (X-4) to be closed in Phase 0b as
  specified, or earlier as a hotfix, since it is also a latent policy issue?

---

## 13. Traceability

Strength words: MUST is binding; RECOMMENDED marks a non-binding preference
(this spec avoids the word "should" per SPEC-FORMAT).

| Requirement | Source evidence | Acceptance |
|---|---|---|
| I-1 pipeline owns ranking | `pg-vector-store.ts:118,316,446,680` | AC-1, AC-3, M5 |
| I-3 capabilities declared | draft design; lexical kind `pg-vector-store.ts:94` | M4 |
| I-5 filters incl. `sourceTsBefore`, `exclude` | `QueryParams` in `types.ts` (absent today) | M5, M17 |
| I-6 factory + default | 33 constructions, section 2.1 | AC-1, AC-2, AC-4 |
| I-7 PG-only set | `schema.ts:3714-3765`, `consolidation.ts:157-169` | M6, M10 |
| X-1 namespace mandatory | `query` WHERE namespace | AC-6, M8 |
| X-3 no sensitive export | `workspaces.dataClass` `schema.ts:1102`; gap grep, X-4 | AC-5, M9 |
| X-5 export prerequisites | recon section 6 | Phase 2 entry |
| L-1 idempotence | `knowledge_chunks_source_idx`, retrieval spec AC-1 | AC-10, M11 |
| L-2 outbox dual write | repo ban on interactive `db.transaction` (CLAUDE.md) | AC-11, M13 |
| L-3 delete not swallowed | `mcp-tools.ts:8559` | AC-8, M10 |
| L-4 purge | workspaces route `:556`, teams route `:351` | AC-9, M10 |
| L-7 embedding space | `_selectEmbedder` `:187` | M3, Phase 2 backfill |
| L-9 rollback | factory default | AC-12, M12 |
| Hybrid baseline gate | `retrieval-baseline.json`, `knowledge-eval.yml` | M1, M2 |
| Recall settings | `_vectorSearch` `:807`; snapshot recall table | M3 |
| T1-T5 triggers | draft thresholds, **[snapshot]** | section 9, M14, M15 |
| $16 floor not activated | task constraint NG2 | Phase 3 approval gate |

Known gaps in this spec: all production figures are the 2026-10-05 snapshot;
whether `knowledge-eval.yml` ran the vector leg in recent CI was not inspected;
no real-Postgres test for the store was found by filename; the raw-SQL module
count is approximate (about 12).

---

**Code surface**: `packages/core/knowledge-store/pg-vector-store.ts`,
`packages/core/knowledge-store/types.ts`,
`packages/core/knowledge-store/voyage-embedder.ts`,
`packages/core/knowledge-store/consolidation.ts`,
`packages/core/mcp-tools.ts`, `packages/core/db/schema.ts`
(`knowledgeChunks`), `packages/core/eval/retrieval-baseline.json`,
`.github/workflows/knowledge-eval.yml`.

**Out of scope**: choosing or buying a vendor plan; changing the MCP tool
surface; the entity extractor and resolver internals; ingest scheduling
(`knowledge-ingest-pipeline`); customer-supplied evidence storage
(`byo-evidence-storage`).
