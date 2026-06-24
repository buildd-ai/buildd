# KnowledgeStore

Hybrid semantic + lexical retrieval over buildd's knowledge: memories, code, docs,
and spec. Designed as a swappable interface (same pattern as `AgentBackend`) so the
backing store can change with zero call-site churn.

## Architecture

```
buildd_memory (MCP)  ──save/update/delete──►  KnowledgeStore.upsert/delete
buildd_memory query_knowledge ──────────────►  KnowledgeStore.query
knowledge-ingest.yml (CI) ──────────────────►  KnowledgeStore.upsert
```

- **`KnowledgeStore`** (`packages/core/knowledge-store/types.ts`) — `upsert`,
  `query`, `delete`, `deleteBySource`, `listNamespaces`. Namespace =
  `{workspaceId}:{corpus}` where corpus ∈ `memory | code | docs | task | artifact |
  pr | plan | session | spec`.
- **`PgVectorStore`** — implementation on the existing Neon/Drizzle Postgres.
  HNSW vector ANN + `tsvector` BM25, fused via Reciprocal Rank Fusion (RRF),
  then an optional cross-encoder rerank. Falls back to lexical-only when no
  embedder is configured.
- **`VoyageEmbedder`** — injectable via the `Embedder` interface. Selects the
  model per-corpus (see table below). Returns `null` from factory functions when
  `VOYAGE_API_KEY` is unset.

### Per-corpus embedder selection

`PgVectorStore._selectEmbedder(corpus)` picks the model at upsert and query time
so stored vectors and query vectors always match:

| Corpus | Embedder | Use case |
|--------|----------|----------|
| `code`, `docs`, `spec` | `voyage-code-3` | Code-forward retrieval, structural understanding |
| `memory`, `task`, `pr`, `plan`, `artifact`, `session` | `voyage-4-large` | General semantic similarity |

Both models output **1024-dim** vectors — a single HNSW index serves all corpora;
namespace filtering (`{workspaceId}:{corpus}`) provides isolation.

### Namespace scheme

`namespace = {workspaceId}:{corpus}` — every query is workspace-isolated. A
worker can only read its own workspace's chunks.

`spec_compare` reads `{workspaceId}:code` and `{workspaceId}:spec` — the same
unified store workers query via `query_knowledge`. No separate namespace or
parallel store.

### Retrieval pipeline

1. **Vector ANN** — `voyage-code-3` or `voyage-4-large` embedding cosine
   similarity (HNSW index). Model selected per-corpus.
2. **BM25** — `websearch_to_tsquery` over `coalesce(lexical_text, content)`.
3. **RRF fusion** — items in both lists score highest; vector-only hits still
   surface. Produces a candidate pool (widened to `topK*5` when a reranker is
   present).
4. **Rerank** (optional) — `VoyageReranker` (`rerank-2.5`) scores each candidate
   against the full query and trims to `topK`. Biggest precision win for top results.

When `VOYAGE_API_KEY` is absent, steps 1 and 4 are skipped and `query_knowledge`
runs lexical-only — no configuration needed.

## Chunking (`chunker.ts`)

Dependency-free, line-oriented, no AST/MDX parser:

- **`chunkMarkdown`** — splits on `#`..`######` headings; each chunk carries its
  ancestor heading path. Oversized sections are sub-split by size with overlap.
  Used for `docs` and `spec` corpora.
- **`chunkCode`** / **`chunkText`** — line-window splitter with character budget
  and overlap, so a definition spanning a boundary still appears whole in one
  chunk. Never truncates: an oversized single line becomes its own chunk.
  Used for `code` corpus.

Each piece tracks `startLine`/`endLine`. Multi-chunk sources get composite ids
`path#startLine` — stable across re-ingest and unique within a file. The unique
index is `(namespace, source_id)`.

## Ingestion

### Automated (CI)

`.github/workflows/knowledge-ingest.yml` runs on every push to `dev` and weekly
on Mondays (06:17 UTC). It ingests the buildd workspace into the production
knowledge store:

| Step | Source | Corpus |
|------|--------|--------|
| Ingest code (packages/) | `packages/**` | `code` |
| Ingest code (apps/) | `apps/**` | `code` |
| Ingest docs | `docs/**` | `docs` |
| Ingest spec | `docs/**` (SPEC.md + plans) | `spec` |

Ingestion is idempotent: SHA-256 content hashing skips unchanged files;
`deleteBySource` removes stale chunks for files that were modified or removed.
Tests, migrations, and generated output dirs are excluded from `code` ingestion.

### Manual (CLI)

```bash
DATABASE_URL=... VOYAGE_API_KEY=... \
  bun packages/core/scripts/ingest-knowledge.ts --corpus code packages/
DATABASE_URL=... VOYAGE_API_KEY=... \
  bun packages/core/scripts/ingest-knowledge.ts --corpus docs docs/
DATABASE_URL=... VOYAGE_API_KEY=... \
  bun packages/core/scripts/ingest-knowledge.ts --corpus spec docs/
```

### Memory backfill

```bash
MEMORY_API_URL=... VOYAGE_API_KEY=... DATABASE_URL=... \
  bun packages/core/scripts/backfill-knowledge-chunks.ts [workspaceId]
```

## spec-validator role

The **spec-validator** is a default role seeded on workspace creation (alongside
Organizer, Builder, Researcher, Writer, Analyst). It automates spec-drift
audits without human setup.

**Configuration:**
- Model: Sonnet; color: amber
- Tools: read-only file tools + `buildd` MCP (`query_knowledge`, `spec_compare`,
  `create_artifact`)

**How to invoke:** dispatch a task to the `spec-validator` role (or pick it in
the role selector). The role is also available via `roleSlug: "spec-validator"`.

**What it produces:**
1. Calls `query_knowledge(corpus: "spec")` for product claims
2. Calls `query_knowledge(corpus: "code")` for implementation evidence
3. Calls `spec_compare` to retrieve cross-corpus candidate pairs
4. Classifies each finding as one of:
   - `MATCHES` — documented and implemented, consistent
   - `DOCUMENTED_NOT_BUILT` — in spec, missing from code
   - `BUILT_NOT_DOCUMENTED` — in code, absent from spec
   - `CONTRADICTED` — code and spec disagree on behavior
5. Emits a drift report artifact summarising all findings

## Design decision: why buildd, not the memory service

Retrieval lives in buildd core, not in the standalone `memory` service. The
memory service stays the source of truth for memories; buildd mirrors them into
`knowledge_chunks` (best-effort on save/update/delete, with the backfill script
to repair drift). Rationale:

- **Cross-corpus.** KnowledgeStore spans `memory`, `code`, `docs`, and `spec`.
  Code and docs are buildd concepts (repos, workspaces) with no home in the
  memory service. Splitting vectors across two services would mean two stores and
  no unified `query_knowledge`.
- **Namespace = workspace.** The namespace key is `workspaceId` — a buildd
  concept. The memory service is scoped by `teamId`/project and doesn't model
  workspaces.
- **Infra already here.** buildd's Neon DB has pgvector + HNSW + tsvector.
  Moving retrieval into the memory service would re-create embeddings, reranking,
  and migrations there from scratch.

The cost is one mirrored copy of low-volume, low-churn memory data — acceptable.

**Revisit only if** `memory.buildd.dev` becomes a shared service that other
products need semantic memory search from. Even then, the memory service would
own only the memory corpus; buildd keeps code/docs/spec, and the `KnowledgeStore`
interface lets the memory corpus be delegated out with zero call-site changes.

## Operational notes

- Requires the `pgvector` extension and migration `0050` (Phase 1).
- Set `VOYAGE_API_KEY` in the environment to enable embeddings + reranking.
- All ingestion is best-effort/idempotent; re-running is safe.
- The CI workflow (`knowledge-ingest.yml`) uses the production `DATABASE_URL` and
  `VOYAGE_API_KEY` secrets — no separate store or Neon branch.
- `spec-sync.yml` is deprecated; the weekly knowledge-ingest job supersedes it.
