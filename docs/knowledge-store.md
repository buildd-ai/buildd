# KnowledgeStore

Hybrid semantic + lexical retrieval over buildd's knowledge: memories, code, and
docs. Designed as a swappable interface (same pattern as `AgentBackend`) so the
backing store can change with zero call-site churn.

## Architecture

```
buildd_memory (MCP)  ──save/update/delete──►  KnowledgeStore.upsert/delete
buildd_memory query_knowledge ──────────────►  KnowledgeStore.query
ingest-knowledge.ts (code+docs) ────────────►  KnowledgeStore.upsert
```

- **`KnowledgeStore`** (`packages/core/knowledge-store/types.ts`) — `upsert`,
  `query`, `delete`, `deleteBySource`, `listNamespaces`. Namespace =
  `{workspaceId}:{corpus}` where corpus ∈ `memory | code | docs`.
- **`PgVectorStore`** — implementation on the existing Neon/Drizzle Postgres.
  HNSW vector ANN + `tsvector` BM25, fused via Reciprocal Rank Fusion (RRF),
  then an optional cross-encoder rerank. Falls back to lexical-only when no
  embedder is configured.
- **`VoyageEmbedder`** (`voyage-code-3`, 1024 dims) and **`VoyageReranker`**
  (`rerank-2`) — injectable via the `Embedder` / `Reranker` interfaces. Both
  return `null` from their `get*()` factory when `VOYAGE_API_KEY` is unset.

### Retrieval pipeline

1. **Vector ANN** — `voyage-code-3` embedding cosine similarity (HNSW index).
2. **BM25** — `websearch_to_tsquery` over `coalesce(lexical_text, content)`.
3. **RRF fusion** — items in both lists score highest; vector-only hits still
   surface. Produces a candidate pool (widened to `topK*5` when a reranker is
   present).
4. **Rerank** (optional) — `rerank-2` scores each candidate against the full
   query and trims to `topK`. Biggest precision win for the top results.

When `VOYAGE_API_KEY` is absent, steps 1 and 4 are skipped and `query_knowledge`
runs lexical-only — no configuration needed.

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

## Ingestion (`ingest.ts`, `scripts/ingest-knowledge.ts`)

`ingestFiles(store, workspaceId, corpus, files)` chunks each file and upserts.
Before re-chunking a file it calls `deleteBySource({ sourcePath })` so a file
that shrank doesn't leave orphaned tail chunks. The CLI walks a repo directory,
classifies files into `code` / `docs` by extension, skips `node_modules`/build
dirs and files > 512 KB, and ingests in batches:

```bash
DATABASE_URL=... VOYAGE_API_KEY=... \
  bun packages/core/scripts/ingest-knowledge.ts <workspaceId> <dir> [--code-only|--docs-only]
```

## Backfill (memories)

```bash
MEMORY_API_URL=... VOYAGE_API_KEY=... DATABASE_URL=... \
  bun packages/core/scripts/backfill-knowledge-chunks.ts [workspaceId]
```

## Phase status

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Store interface, PgVectorStore (vector+BM25+RRF), VoyageEmbedder, `knowledge_chunks` table, memory ingestion, `query_knowledge` | ✅ shipped (#865) |
| 2 | Code + docs chunking, multi-chunk sources, `deleteBySource`, ingestion CLI | ✅ this change |
| 3 | Cross-encoder reranking (`rerank-2`), wider candidate pool | ✅ this change |
| 4 | `TurbopufferStore` — alternate backend, new class, zero call-site changes | ⬜ deferred (interface is ready) |

## Operational notes

- Requires the `pgvector` extension and migration `0050` (Phase 1).
- Set `VOYAGE_API_KEY` in the environment to enable embeddings + reranking.
- All ingestion is best-effort/idempotent; re-running is safe.
