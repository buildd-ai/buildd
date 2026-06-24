# KnowledgeStore

Hybrid semantic + lexical retrieval over buildd's knowledge: memories, code, and
docs. Two separate pipelines share the same storage and embedder infrastructure
but serve different purposes with different namespaces and access controls.

---

## Two-system architecture

| | **System A — General store** | **System B — Spec-sync corpus** |
|---|---|---|
| **Purpose** | Worker-facing product recall (memories, task history, code lookup) | Dev-loop drift detection (code vs docs) |
| **Tool** | `buildd_memory action=query_knowledge` | `buildd action=spec_compare` |
| **Embedder** | `voyage-4-large` (1024 dims) | `voyage-4-large` (1024 dims) — same model |
| **Namespace** | `{workspaceId}:{corpus}` (or `{teamId}:memory`) | `{SPEC_SYNC_NAMESPACE}:{code\|docs}` (default UUID `471effe1-…`) |
| **Corpora populated** | `memory`, `task`, `pr`, `plan`, `artifact` (auto-indexed); `code`/`docs` via CLI | `code`, `docs` (buildd repo + 4 doc repos) |
| **Ingestion** | Memories: best-effort mirror on each write. Code/docs: manual `ingest-knowledge.ts` CLI | Manual `ingest-spec-corpus.sh` |
| **Access** | Worker-level (any authenticated worker) | Admin-only |

> **voyage-4-large, not voyage-code-3.** Earlier versions of this doc (and the
> spec-sync skill) claimed `voyage-code-3`. That was an aspirational design note
> that was never implemented. Both systems use the same `getVoyageEmbedder()`
> factory, which hardcodes `DEFAULT_MODEL = 'voyage-4-large'`. `voyage-4-large`
> handles both natural language and code well — the original design rationale for
> not using a code-specialist model. No production data has ever been embedded with
> `voyage-code-3`.

---

## System A — General KnowledgeStore

### Architecture

```
buildd_memory (MCP)  ──save/update/delete──►  KnowledgeStore.upsert/delete
buildd_memory query_knowledge ──────────────►  KnowledgeStore.query
ingest-knowledge.ts (code+docs) ────────────►  KnowledgeStore.upsert
auto-indexer (tasks/PRs/artifacts/plans) ────►  KnowledgeStore.upsert (best-effort)
```

- **`KnowledgeStore`** (`packages/core/knowledge-store/types.ts`) — `upsert`,
  `query`, `delete`, `deleteBySource`, `listNamespaces`. Namespace =
  `{workspaceId}:{corpus}` where corpus ∈ `memory | code | docs | task | pr |
  plan | artifact | session`.
  Exception: `memory` corpus uses `{teamId}:memory` (team-scoped).
- **`PgVectorStore`** — implementation on the existing Neon/Drizzle Postgres.
  HNSW vector ANN + `tsvector` BM25, fused via Reciprocal Rank Fusion (RRF),
  then an optional cross-encoder rerank. Falls back to lexical-only when no
  embedder is configured.
- **`VoyageEmbedder`** (`voyage-4-large`, 1024 dims) and **`VoyageReranker`**
  (`rerank-2.5`) — injectable via the `Embedder` / `Reranker` interfaces. Both
  return `null` from their `get*()` factory when `VOYAGE_API_KEY` is unset.

### Retrieval pipeline

1. **Vector ANN** — `voyage-4-large` embedding cosine similarity (HNSW index).
2. **BM25** — `websearch_to_tsquery` over `coalesce(lexical_text, content)`.
3. **RRF fusion** — items in both lists score highest; vector-only hits still
   surface. Produces a candidate pool (widened to `topK*5` when a reranker is
   present).
4. **Rerank** (optional) — `rerank-2.5` scores each candidate against the full
   query and trims to `topK`. Biggest precision win for the top results.

When `VOYAGE_API_KEY` is absent, steps 1 and 4 are skipped and `query_knowledge`
runs lexical-only — no configuration needed.

### code/docs corpus status

The `{workspaceId}:code` and `{workspaceId}:docs` namespaces are **never
auto-populated**. Running `ingest-knowledge.ts` against the workspace would fill
them, but this has not been done for the buildd workspace. As a result,
`query_knowledge(corpus:code|docs)` currently returns empty results.

PR [#959](https://github.com/buildd-ai/buildd/pull/959) (pending) fixes this by
routing `query_knowledge(corpus:code|docs)` to read from the spec-sync namespace
(`SPEC_SYNC_NAMESPACE:{corpus}`) instead, making the already-populated spec-sync
index available to workers. See [Recommendations](#recommendations) for the
design decision this implies.

---

## System B — Spec-sync corpus

The spec-sync corpus is a **dedicated, ephemeral dev-loop index** used only by
`spec_compare` (admin-only). It is separate from the product workspace namespaces.

### Namespace

`{SPEC_SYNC_NAMESPACE}:code` and `{SPEC_SYNC_NAMESPACE}:docs`.

The default `SPEC_SYNC_NAMESPACE` is hardcoded in `packages/core/mcp-tools.ts`
as `471effe1-4668-4cc9-9fa3-e20a56769deb`. Override via the `SPEC_SYNC_NAMESPACE`
env var on any deployment.

The ingestion script uses `SPEC_WORKSPACE_ID` (passed as CLI arg to
`ingest-knowledge.ts`). Ensure `SPEC_WORKSPACE_ID` matches `SPEC_SYNC_NAMESPACE`
when running locally.

### What's ingested

```bash
bash .claude/skills/spec-sync/scripts/ingest-spec-corpus.sh
```

Ingests four sources into the namespace:
1. `buildd/packages` + `buildd/apps` — source code (clean: migrations + tests
   excluded via `INGEST_SKIP_DIRS=drizzle,__tests__ INGEST_SKIP_TESTS=1`)
2. `buildd/docs` — internal docs (SPEC.md, knowledge-store.md, etc.)
3. `buildd-docs` — user-facing documentation site
4. `buildd-site` + `knowledge-base` — marketing/support content

### Embedder

`voyage-4-large` (1024 dims) — same `getVoyageEmbedder()` factory as System A.
The corpus is **ephemeral and rebuildable**: re-run the script anytime; prior
chunks are cleared per file (`deleteBySource`).

### Access

`spec_compare` is **admin-only** (`if (level !== 'admin') throw`). Workers
cannot call it. See the [Recommendations](#recommendations) section on the
access inversion this creates.

---

## Chunking (`chunker.ts`)

Dependency-free, line-oriented, no AST/MDX parser:

- **`chunkMarkdown`** — splits on `#`..`######` headings; each chunk carries its
  ancestor heading path. Oversized sections are sub-split by size with overlap.
- **`chunkCode`** / **`chunkText`** — line-window splitter with character budget
  and overlap, so a definition spanning a boundary still appears whole in one
  chunk. Never truncates: an oversized single line becomes its own chunk.

Each piece tracks `startLine`/`endLine`. Multi-chunk sources get composite ids
`path#startLine` — stable across re-ingest and unique within a file. This is why
the unique index is `(namespace, source_id)` and code/docs need no schema change
over Phase 1.

---

## Ingestion

### General store (`ingest.ts`, `scripts/ingest-knowledge.ts`)

`ingestFiles(store, workspaceId, corpus, files)` chunks each file and upserts.
Before re-chunking a file it calls `deleteBySource({ sourcePath })` so a file
that shrank doesn't leave orphaned tail chunks. The CLI walks a repo directory,
classifies files into `code` / `docs` by extension, skips `node_modules`/build
dirs and files > 512 KB, and ingests in batches:

```bash
DATABASE_URL=... VOYAGE_API_KEY=... \
  bun packages/core/scripts/ingest-knowledge.ts <workspaceId> <dir> [--code-only|--docs-only]
```

### Spec-sync corpus

```bash
SPEC_WORKSPACE_ID=<dedicated-uuid> \
DATABASE_URL=<target-db> \
VOYAGE_API_KEY=<key> \
  bash .claude/skills/spec-sync/scripts/ingest-spec-corpus.sh
```

### Backfill (memories)

```bash
MEMORY_API_URL=... VOYAGE_API_KEY=... DATABASE_URL=... \
  bun packages/core/scripts/backfill-knowledge-chunks.ts [workspaceId]
```

---

## Design decision: why buildd, not the memory service

Retrieval lives in buildd core, not in the standalone `memory` service. The
memory service stays the source of truth for memories; buildd mirrors them into
`knowledge_chunks` (best-effort on save/update/delete, with the backfill script
to repair drift). Rationale:

- **Cross-corpus.** KnowledgeStore spans `memory`, `code`, and `docs`. Code and
  docs are buildd concepts (repos, workspaces) with no home in the memory
  service. Splitting vectors across two services would mean two stores and no
  unified `query_knowledge`.
- **Namespace = workspace.** The namespace key is `workspaceId` — a buildd
  concept. The memory service is scoped by `teamId`/project and doesn't model
  workspaces.
- **Infra already here.** buildd's Neon DB has pgvector + HNSW + tsvector.
  Moving retrieval into the memory service would re-create embeddings, reranking,
  and migrations there from scratch.

The cost is one mirrored copy of low-volume, low-churn memory data — acceptable.

---

## Recommendations

These are open decisions for the owner; none are implemented here.

### 1. Access inversion

`spec_compare` (admin-only) queries the only **actually-populated** code/docs
namespace. Workers can call `query_knowledge(code)` but get empty results from
the unpopulated `{workspaceId}:code` namespace.

**PR #959** resolves this by routing `query_knowledge(code|docs)` to read from
`SPEC_SYNC_NAMESPACE` — the same namespace `spec_compare` uses. This makes the
spec-sync index the de-facto worker-facing code corpus.

Decision: **should the spec-sync index be the single source of truth for code/docs
for both workers and admin tooling?** If yes, merge PR #959. If no (workers should
have a workspace-specific index), populate `{workspaceId}:code` via
`ingest-knowledge.ts` and keep the two namespaces separate.

### 2. Redundancy: two code corpora

After PR #959, `{workspaceId}:code` would still exist as a valid namespace key
but be queried by nothing. Options:
- **Remove `code`/`docs` from the worker-accessible corpus list** (keeps the
  namespace but prevents confusion).
- **Keep both** and populate `{workspaceId}:code` via `ingest-knowledge.ts` for
  workspace-specific knowledge (e.g., multi-repo workspaces where the spec-sync
  index only covers the buildd repo).
- **Consolidate** — make spec-sync write into `{workspaceId}:code` instead of its
  own namespace, eliminating the separation. Simplest; loses the isolation that
  prevents product data from polluting drift-detection.

**Recommendation**: merge PR #959 (unblocks workers now), document that
`{workspaceId}:code` is available but unused for per-workspace overrides. Revisit
if multi-repo workspaces need workspace-specific indexes.

### 3. Task 9259187b — should it be considered complete?

Task `9259187b` was scoped to "run Phase 2 ingestion for the buildd workspace."
Its actual outcome (PR #959) instead re-routes the existing spec-sync namespace.
No `ingest-knowledge.ts` run was performed; no chunks live in `{workspaceId}:code`.

The underlying need ("workers can query codebase semantically") is met by PR #959.
But if a workspace-specific index was the intent, the task is only half-done.
Recommend treating it as complete once PR #959 merges, and tracking
workspace-specific ingestion as a separate concern.

### 4. voyage-code-3 as a future option

The `VoyageEmbedder` constructor accepts a `model` parameter, so it is possible
to use `voyage-code-3` for the spec-sync pipeline without touching general-store
behavior. This would require:
- An env var or CLI flag to pass a non-default model to `ingest-knowledge.ts`
- Running a full re-ingest of the spec-sync corpus with the new model

The risk: `voyage-code-3` is code-specialist and may score prose docs worse than
`voyage-4-large`. Since the spec-sync corpus embeds both source code AND markdown
docs, `voyage-4-large`'s general strength may be preferable. Defer unless drift
detection quality is a demonstrated problem.

---

## Phase status

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Store interface, PgVectorStore (vector+BM25+RRF), VoyageEmbedder, `knowledge_chunks` table, memory ingestion, `query_knowledge` | ✅ shipped (#865) |
| 2 | Code + docs chunking, multi-chunk sources, `deleteBySource`, ingestion CLI | ✅ shipped |
| 3 | Cross-encoder reranking (`rerank-2.5`), wider candidate pool | ✅ shipped |
| 4 | `query_knowledge(code|docs)` → spec-sync namespace (PR #959) | 🔄 pending merge |
| 5 | `TurbopufferStore` — alternate backend, new class, zero call-site changes | ⬜ deferred (interface is ready) |

---

## Operational notes

- Requires the `pgvector` extension and migration `0050` (Phase 1).
- Set `VOYAGE_API_KEY` in the environment to enable embeddings + reranking.
- All ingestion is best-effort/idempotent; re-running is safe.
- The embedding model stored in `embedding_model` per row (see `knowledge_chunks`
  schema) makes mixed-model corpora detectable if the model ever changes.
