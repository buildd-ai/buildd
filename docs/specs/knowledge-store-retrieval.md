---
title: Knowledge Store Retrieval
status: active
owner: max
last_verified: 2026-07-18
supersedes: []
---
# Knowledge Store & Retrieval

**Capability statement**: The buildd knowledge store MUST ingest content from
`memory`, `code`, `docs`, `task`, `artifact`, `pr`, `plan`, and `session`
corpora into `knowledge_chunks`, retrieve it via hybrid semantic + lexical
search fused with RRF, and expose it to agents through the `query_knowledge`
action and `spec_compare` tool — falling back to lexical-only search when no
embedder is configured.

---

## Storage Model

**Invariants**:
- Every chunk has a stable `(namespace, source_id)` primary key
  (`knowledge_chunks` unique index). Upserts are idempotent — re-ingesting
  unchanged content MUST NOT produce duplicate rows.
- `namespace = "{workspaceId}:{corpus}"`. All memory chunks for a workspace live
  in `{workspaceId}:memory`; code chunks in `{workspaceId}:code`; etc.
- `contentHash` (SHA-256 of `content`) MUST be stored and MUST match current
  content. When unchanged, no re-embed is required.
- Chunks store both `content` (full text) and `lexical_text` (may be title +
  content for memories) — BM25 searches `lexical_text`.
- `embedding` is `vector(1024)` using `voyage-code-3` (1024 dims, HNSW index).
  When `VOYAGE_API_KEY` is absent, `embedding` is `NULL` and only lexical search
  runs.

**Acceptance criteria**:
- AC-1: GIVEN the same `(namespace, source_id)` with unchanged content WHEN
  `upsert` is called a second time THEN `knowledge_chunks` has exactly one row
  for that `(namespace, source_id)` — no duplicate is inserted.
- AC-2: GIVEN a file that was ingested and then shortened WHEN
  `deleteBySource({ sourcePath })` is called before re-ingesting THEN no orphan
  tail chunks remain for that file.
- AC-3: WHEN `VOYAGE_API_KEY` is absent THEN `upsert` stores chunks with
  `embedding = NULL` and `query` still returns lexical-matched results.

**Code surface**:
- Store: `packages/core/knowledge-store/pg-vector-store.ts` — `PgVectorStore`
- Schema: `packages/core/db/schema.ts` — `knowledgeChunks` table
- Ingest: `packages/core/knowledge-store/ingest.ts` — `ingestFiles()`
- Types: `packages/core/knowledge-store/types.ts` — `KnowledgeStore`,
  `UpsertChunk`, `QueryParams`, `Corpus`

---

## Retrieval Pipeline

**Capability statement**: `PgVectorStore.query` MUST fuse vector ANN and BM25
results via Reciprocal Rank Fusion (RRF), optionally rerank with a cross-encoder,
and return at most `topK` results scoped to the given namespace.

**Invariants**:
- Vector ANN: HNSW cosine similarity on `voyage-code-3` embeddings. Skipped when
  `embedding IS NULL` (no embedder).
- BM25: `websearch_to_tsquery` over `coalesce(lexical_text, content)`.
- RRF fusion: `score = Σ 1/(k + rank)` for each candidate across both lists
  (`k = 60`). Items appearing in both lists rank highest.
- When a `Reranker` is configured, a wider candidate pool (`min(topK*5, 100)`)
  is fetched and then trimmed to `topK` by cross-encoder score.
- `topK` MUST be capped at 50 before querying (`Math.min(topK, 50)`).
- Corpus filter (`filters.corpus`) constrains results to a single corpus within
  the namespace.

**Acceptance criteria**:
- AC-4: GIVEN chunks from both vector and lexical results WHEN RRF is applied
  THEN a chunk appearing in both lists has a higher fused score than a chunk in
  only one list.
- AC-5: GIVEN `mode: 'vector'` in `QueryParams` WHEN `query` is called THEN
  only vector ANN is run (no BM25).
- AC-6: GIVEN `mode: 'lexical'` WHEN `query` is called THEN only BM25 runs
  (no vector ANN, even when embedder is present).
- AC-7: GIVEN `topK: 100` WHEN `query` is called THEN at most 50 results are
  returned (cap enforced).
- AC-8: GIVEN `filters: { corpus: 'task' }` WHEN `query` is called THEN all
  returned results have `corpus = 'task'`.

**Code surface**:
- `packages/core/knowledge-store/pg-vector-store.ts` — `query()`,
  `reciprocalRankFusion()`
- `packages/core/knowledge-store/reranker.ts` — `applyRerank()`
- Embedder: `packages/core/knowledge-store/voyage-embedder.ts`

---

## Chunking Strategy

**Invariants**:
- Markdown is chunked on heading boundaries (`#`–`######`); each chunk carries
  the ancestor heading path as context.
- Code and plain text use a line-window splitter with a character budget and
  overlap — a definition spanning a boundary appears whole in at least one chunk.
- Multi-chunk sources get composite IDs `{path}#{startLine}` — stable across
  re-ingest.
- No chunk truncates mid-line; an oversized single line becomes its own chunk.

**Acceptance criteria**:
- AC-9: GIVEN a markdown file with `## Section` followed by 500 lines WHEN
  chunked THEN the heading text appears in the first chunk for that section.
- AC-10: GIVEN a code file where a function starts on line 10 and ends on line
  80 WHEN chunked with default parameters THEN the function body appears in at
  most 2 consecutive overlapping chunks (not scattered across many).

**Code surface**:
- `packages/core/knowledge-store/chunker.ts` — `chunkMarkdown()`, `chunkCode()`,
  `chunkText()`

---

## Memory Mirroring

**Invariants**:
- When `buildd_memory save` or `update` is called, the MCP handler MUST mirror
  the memory into `knowledge_chunks` (namespace `{workspaceId}:memory`) via a
  best-effort `upsert` — failures MUST NOT block the memory save.
- When `buildd_memory delete` is called, the corresponding chunk MUST be deleted
  from `knowledge_chunks` (best-effort).
- The external memory service (`memory.buildd.dev`) remains the source of truth
  for memories; `knowledge_chunks` holds a searchable mirror.

**Acceptance criteria**:
- AC-11: GIVEN a successful `buildd_memory save` WHEN the upsert to
  `knowledge_chunks` fails THEN the memory save still succeeds (best-effort
  mirror).
- AC-12: GIVEN a memory that exists in both the external service and
  `knowledge_chunks` WHEN `buildd_memory delete` is called THEN the
  `knowledge_chunks` row for that memory is removed.

**Code surface**:
- Mirror logic: `packages/core/mcp-tools.ts` — `handleMemoryAction()`
- Knowledge store wiring in MCP context: `apps/web/src/app/api/mcp/route.ts`

---

## `query_knowledge` MCP action

**Capability statement**: The `query_knowledge` action MUST perform hybrid
retrieval over the workspace's knowledge store and return ranked results with
`sourceUrl` so agents can navigate to the original source.

**Invariants**:
- Default `corpus` is `memory`; all other corpora (`task`, `pr`, `plan`,
  `artifact`, `code`, `docs`) are valid filter values.
- Default `topK = 10`, `mode = 'hybrid'`.
- Each result MUST include at minimum: `content`, `sourceUrl` (may be null),
  `corpus`, `score`.

**Acceptance criteria**:
- AC-13: WHEN `query_knowledge` is called with `query: "authentication"` and no
  corpus filter THEN results are returned only from the `memory` corpus.
- AC-14: WHEN `query_knowledge` is called with `corpus: "code"` THEN results are
  from the `{workspaceId}:code` namespace only.
- AC-15: GIVEN no chunks indexed for the workspace WHEN `query_knowledge` is
  called THEN an empty array is returned (not an error).

**Code surface**:
- MCP handler: `packages/core/mcp-tools.ts` — `handleMemoryAction()`,
  `query_knowledge` branch
- Store: `packages/core/knowledge-store/pg-vector-store.ts` — `query()`

---

## `spec_compare` MCP action

**Capability statement**: `spec_compare` MUST retrieve CODE-side and DOCS-side
evidence for a named feature from the spec-sync corpus and return both to the
caller for manual judgement — the tool MUST NOT compute a verdict itself.

**Invariants**:
- `spec_compare` is admin-only.
- The namespace used is `SPEC_SYNC_NAMESPACE` env var (overridable per call).
- Results include `topK` (default 5, max 20) candidates from each side.
- No server-side verdict is produced — callers read the snippets and judge.

**Acceptance criteria**:
- AC-16: WHEN `spec_compare` is called with a `worker` token THEN the response
  contains `isError: true`.
- AC-17: WHEN `spec_compare` is called with `topK: 25` THEN the server caps
  the result to 20 candidates.

**Code surface**:
- MCP handler: `packages/core/mcp-tools.ts` — `spec_compare` action branch
- Knowledge store retrieval: `packages/core/knowledge-store/pg-vector-store.ts`

**Out of scope**: The `TurbopufferStore` alternate backend (interface-ready,
not yet implemented). The ingestion CLI scripts (operational tooling, not a
runtime contract). The external memory service API (separate repo
`buildd-ai/memory`).
