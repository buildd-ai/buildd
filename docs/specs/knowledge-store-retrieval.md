---
title: Knowledge Store Retrieval
status: active
owner: max
last_verified: 2026-10-15
summary: The knowledge store MUST keep every corpus in knowledge_chunks as idempotent (namespace, source_id) rows, team-scoped for memory and initiative and workspace-scoped otherwise, and retrieve them via RRF-fused Voyage vector search plus Postgres full-text search, falling back to full-text only with no embedder.
domain: knowledge
surfaces: [packages/core/knowledge-store/pg-vector-store.ts, packages/core/knowledge-store/voyage-embedder.ts, packages/core/knowledge-store/ingest.ts, packages/core/knowledge-store/chunker.ts, packages/core/memory-write.ts, packages/core/mcp-tools.ts]
related: [mcp-action-contracts, mission-task-lifecycle, pluggable-knowledge-store]
keywords: [knowledge_chunks, rrf, websearch_to_tsquery, lexical_tsv, voyage-4-large, voyage-code-3, rerank-2.5, query_knowledge, spec_compare]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "vector-store"
    type: "symbol"
    name: "PgVectorStore"
    path: "packages/core/knowledge-store/pg-vector-store.ts"
  - id: "rank-fusion"
    type: "symbol"
    name: "reciprocalRankFusion"
    path: "packages/core/knowledge-store/pg-vector-store.ts"
  - id: "file-ingestion"
    type: "symbol"
    name: "ingestFiles"
    path: "packages/core/knowledge-store/ingest.ts"
---
# Knowledge Store & Retrieval

**Capability statement**: The buildd knowledge store MUST keep content from
every corpus in the `Corpus` type (`memory`, `code`, `docs`, `spec`, `task`,
`artifact`, `pr`, `plan`, `session`, `initiative`, `evidence`) in
`knowledge_chunks`, retrieve it by fusing a Voyage vector search with a
Postgres full-text search through RRF, and expose it to agents through
`query_knowledge`, `recall` and `spec_compare`. With no embedder configured,
retrieval falls back to full-text search only.

---

## Storage Model

**Invariants**:
- Every chunk has a stable `(namespace, source_id)` key (`knowledge_chunks`
  unique index). Upserts are idempotent: re-ingesting unchanged content MUST
  NOT produce duplicate rows.
- `namespace = "{scopeId}:{corpus}"`, built by `buildNamespace`. The scope
  depends on the corpus (`knowledgeNamespace` in `packages/core/mcp-tools.ts`):
  - `memory` and `initiative` are team-scoped: `{teamId}:memory`,
    `{teamId}:initiative`. Every workspace in the team reads the same
    namespace. A team id and a workspace id are different values by design.
  - Every other corpus is workspace-scoped: `{workspaceId}:code`,
    `{workspaceId}:docs`, `{workspaceId}:spec`, `{workspaceId}:task`, and so
    on. `{workspaceId}:evidence` is built by `evidenceNamespace` in
    `apps/web/src/lib/evidence-indexer.ts`.
- `contentHash` (SHA-256 of `content`) MUST be stored and MUST match the
  current content. `file_hash` (SHA-256 of the whole source file) lets ingest
  skip re-embedding a file that did not change.
- Chunks store `content` and `lexical_text` (for a memory, title plus
  content). Full-text search reads the generated column `lexical_tsv`,
  `to_tsvector('english', coalesce(lexical_text, content))`, so the vector is
  not recomputed per query.
- `embedding` is `vector(1024)` with an HNSW index. Two Voyage models write
  into it, both 1024 dimensions: `voyage-code-3` for the `code`, `docs` and
  `spec` corpora (`isCodeCorpus`, `getCodeEmbedder`) and `voyage-4-large` for
  every other corpus (`getVoyageEmbedder` default). Namespaces keep the two
  embedding spaces apart. When `VOYAGE_API_KEY` is absent, `embedding` is
  `NULL` and only full-text search runs.
- A chunk can be superseded (`is_current = false`, `superseded_by`). Queries
  skip superseded chunks unless `history: true`.

**Acceptance criteria**:
- AC-1: GIVEN the same `(namespace, source_id)` with unchanged content WHEN
  `upsert` is called a second time THEN `knowledge_chunks` has exactly one row
  for that `(namespace, source_id)`.
- AC-2: GIVEN a file that was ingested and then shortened WHEN
  `deleteBySource({ sourcePath })` is called before re-ingesting THEN no orphan
  tail chunks remain for that file.
- AC-3: WHEN `VOYAGE_API_KEY` is absent THEN `upsert` stores chunks with
  `embedding = NULL` and `query` still returns full-text matches.
- AC-18: GIVEN a memory written from any workspace of a team WHEN it is
  mirrored THEN it lands in `{teamId}:memory`, and a recall from another
  workspace of the same team reads that namespace.
- AC-19: GIVEN a chunk upserted into a namespace whose corpus is `code`, `docs`
  or `spec` WHEN Voyage is configured THEN it is embedded with
  `voyage-code-3`; a chunk in any other corpus is embedded with
  `voyage-4-large`.

**Code surface**:
- Store: `packages/core/knowledge-store/pg-vector-store.ts`: `PgVectorStore`,
  `buildNamespace`
- Embedder: `packages/core/knowledge-store/voyage-embedder.ts`:
  `VoyageEmbedder`, `getVoyageEmbedder`, `getCodeEmbedder`, `isCodeCorpus`,
  `getVoyageEmbedderForCorpus`
- Schema: `packages/core/db/schema.ts`: `knowledgeChunks`
- Ingest: `packages/core/knowledge-store/ingest.ts`: `ingestFiles()`
- Types: `packages/core/knowledge-store/types.ts`: `KnowledgeStore`,
  `UpsertChunk`, `QueryParams`, `Corpus`

---

## Retrieval Pipeline

**Capability statement**: `PgVectorStore.query` MUST fuse vector search and
full-text search with Reciprocal Rank Fusion (RRF), rerank with a
cross-encoder when one is configured, and return at most `topK` results from
the given namespace.

**Invariants**:
- Vector leg: HNSW cosine search on the query embedded with
  `inputType: 'query'`, by the same model the namespace's corpus is written
  with (`_selectEmbedder`). Skipped when there is no embedder.
- Lexical leg: Postgres full-text search, not BM25.
  `buildLexicalSearchSql` matches `lexical_tsv @@ websearch_to_tsquery('english', text)`
  and orders by `ts_rank`. No trigram or BM25 scoring is involved.
- Hybrid mode runs both legs concurrently and fuses them with
  `reciprocalRankFusion`: `score = sum of 1/(k + rank)` over both lists,
  `k = 60`. A chunk in both lists ranks above a chunk in one.
- `mode: 'vector'` runs only the vector leg. `mode: 'lexical'`, or hybrid with
  no embedder, runs only the full-text leg.
- When a `Reranker` is configured (Voyage `rerank-2.5`, `getVoyageReranker`),
  a wider candidate pool (`min(topK * 5, 100)`) is fetched and trimmed to
  `topK` by cross-encoder score.
- After fusion, a 1-hop graph expansion adds neighbouring chunks
  (`useGraph`, default true; skipped quietly if the graph tables are absent).
  `_finalize` then applies the rerank and the corpus-authority x recency decay
  (`recencyAuthority`, default true). With a reranker, the rerank score
  replaces the decayed score.
- Returned chunks get a fire-and-forget hit record (`trackHits`, default true)
  that never blocks or fails the query.
- `topK` MUST be capped at 50 before querying (`Math.min(topK, 50)`).
- `filters.corpus` limits results to one corpus; `filters.sourceType` to one
  source type.

**Acceptance criteria**:
- AC-4: GIVEN chunks from both vector and full-text results WHEN RRF is
  applied THEN a chunk in both lists has a higher fused score than a chunk in
  only one.
- AC-5: GIVEN `mode: 'vector'` in `QueryParams` WHEN `query` is called THEN
  only the vector leg runs.
- AC-6: GIVEN `mode: 'lexical'` WHEN `query` is called THEN only the
  full-text leg runs, even when an embedder is present.
- AC-7: GIVEN `topK: 100` WHEN `query` is called THEN at most 50 results are
  returned.
- AC-8: GIVEN `filters: { corpus: 'task' }` WHEN `query` is called THEN all
  returned results have `corpus = 'task'`.
- AC-20: GIVEN a superseded chunk WHEN `query` is called without
  `history: true` THEN it is not returned.

**Code surface**:
- `packages/core/knowledge-store/pg-vector-store.ts`: `query()`,
  `buildLexicalSearchSql()`, `reciprocalRankFusion()`
- `packages/core/knowledge-store/reranker.ts`: `VoyageReranker`,
  `applyRerank()`
- `packages/core/knowledge-store/recency-authority.ts`:
  `applyRecencyAuthority()`

---

## Chunking Strategy

**Invariants**:
- Markdown is chunked on heading boundaries (`#` to `######`); each chunk
  carries the ancestor heading path as context.
- Code with known top-level declarations is chunked on declaration boundaries
  (`chunkCodeSymbols`); a declaration over the budget, and code with no
  symbols, fall back to the line-window splitter with a character budget and
  overlap, so a definition spanning a boundary appears whole in at least one
  chunk.
- Multi-chunk sources get composite ids `{path}#{startLine}`, stable across
  re-ingest.
- No chunk truncates mid-line; an oversized single line becomes its own chunk.

**Acceptance criteria**:
- AC-9: GIVEN a markdown file with `## Section` followed by 500 lines WHEN
  chunked THEN the heading text appears in the first chunk for that section.
- AC-10: GIVEN a code file where a function starts on line 10 and ends on line
  80 WHEN chunked with default parameters THEN the function body appears in at
  most 2 consecutive overlapping chunks.

**Code surface**:
- `packages/core/knowledge-store/chunker.ts`: `chunkMarkdown()`,
  `chunkCodeSymbols()`, `chunkCode()`, `chunkText()`

---

## Memory Mirroring

**Invariants**:
- Every memory write path (`learn`, the deprecated `buildd_memory`
  `save`/`update`, the dashboard, the feedback digest) mirrors the memory into
  `{teamId}:memory` through `mirrorMemoryToIndex` in
  `packages/core/memory-write.ts`. The mirror never throws: a failure is
  logged with `MEMORY_MIRROR_FAILED_TAG` and MUST NOT block the save.
- `reconcileMemoryIndex` in `packages/core/memory-index-reconcile.ts` repairs
  the index on an existing cron: it mirrors live rows with no chunk or a stale
  chunk, and flips the chunk of a superseded row to not current.
- When a memory is deleted (`buildd` action `memory_delete`, the deprecated
  `buildd_memory delete`, or the dashboard), its chunk MUST be deleted from
  `{teamId}:memory` (best-effort).
- The `memories` table is the source of truth, read and written in-process via
  `packages/core/memory-store.ts`; `knowledge_chunks` holds a searchable mirror.

**Acceptance criteria**:
- AC-11: GIVEN a successful memory write WHEN the upsert to `knowledge_chunks`
  fails THEN the memory save still succeeds.
- AC-12: GIVEN a memory that exists in both the `memories` table and
  `knowledge_chunks` WHEN it is deleted THEN the `knowledge_chunks` row for that
  memory is removed.

**Code surface**:
- Mirror: `packages/core/memory-write.ts`: `mirrorMemoryToIndex()`,
  `memoryIndexChunk()`
- Repair: `packages/core/memory-index-reconcile.ts`: `reconcileMemoryIndex()`
- Delete: `packages/core/mcp-tools.ts`: `handleMemoryAction()` `delete` branch

---

## `query_knowledge` MCP action

**Capability statement**: The `query_knowledge` action MUST run hybrid
retrieval over one or more corpora the caller can read and return ranked
results with `sourceUrl`, so agents can open the original source.

**Invariants**:
- The callable corpus list is `CORPORA` in `packages/core/mcp-tools.ts`:
  `memory`, `task`, `pr`, `plan`, `artifact`, `code`, `docs`, `spec`,
  `initiative`, `evidence`. `session` is a `Corpus` value but internal and not
  callable. `parseCorpora` rejects any other value with the valid list.
- Default `corpus` is `memory`; default `topK = 10` (capped at 50),
  `mode = 'hybrid'`.
- An array of corpora fans out concurrently and is fused with RRF (`k = 60`).
- `memory` reads are scoped to the caller's project and go through
  `retrieveMemory`. A sensitive workspace reads nothing from `memory`,
  `initiative` or `evidence` (`SENSITIVE_WITHHELD_CORPORA`).
- Each result includes at least `content`, `sourceUrl` (may be null),
  `corpus` and `score`.

**Acceptance criteria**:
- AC-13: WHEN `query_knowledge` is called with `query: "authentication"` and no
  corpus THEN results come only from the `memory` corpus.
- AC-14: WHEN `query_knowledge` is called with `corpus: "code"` THEN results
  come from the `{workspaceId}:code` namespace only.
- AC-15: GIVEN no chunks indexed for the workspace WHEN `query_knowledge` is
  called THEN it answers with no results, not an error.
- AC-21: GIVEN `corpus: "tasks"` (not in `CORPORA`) WHEN `query_knowledge` is
  called THEN it fails with the list of valid corpora.

**Code surface**:
- MCP handler: `packages/core/mcp-tools.ts`: `handleMemoryAction()`
  `query_knowledge` branch, `parseCorpora()`, `knowledgeNamespace()`,
  `CORPORA`
- Store: `packages/core/knowledge-store/pg-vector-store.ts`: `query()`

---

## `spec_compare` MCP action

**Capability statement**: `spec_compare` MUST retrieve docs-side and code-side
evidence for a named feature from the caller's workspace and return both for
the caller to judge. The tool MUST NOT compute a verdict.

**Invariants**:
- Access: `spec_compare` is in `workerActions`, so a worker or admin token can
  call it; a trigger token cannot. A scoped token needs `tasks:read`
  (`packages/core/token-scopes.ts`). It reads only what `query_knowledge`
  already reaches.
- It reads the caller's own workspace, never a configured namespace:
  `{workspaceId}:docs` for the prose side and `{workspaceId}:code` for the
  code side. It does not read `{workspaceId}:spec`. With no workspace in
  context it fails.
- Two hops: it queries `docs` and `code` in parallel (hybrid), extracts
  implementation anchors from the docs hits (`extractImplementationAnchors`:
  paths, identifiers, routes), runs a full-text `code` query on those anchors,
  and merges the two code lists by best score.
- `topK` defaults to 5 and is capped at 20, per side.
- No server-side verdict is produced.

**Acceptance criteria**:
- AC-16: WHEN `spec_compare` is called with a `trigger` token THEN it is
  refused; with a `worker` token it returns both
  sides.
- AC-17: WHEN `spec_compare` is called with `topK: 25` THEN each side returns
  at most 20 candidates.
- AC-22: WHEN `spec_compare` runs THEN its prose side comes from
  `{workspaceId}:docs` and its code side from `{workspaceId}:code` of the
  caller's workspace.

**Code surface**:
- MCP handler: `packages/core/mcp-tools.ts`: `spec_compare` action branch,
  `extractImplementationAnchors()`, `workerActions`
- Store: `packages/core/knowledge-store/pg-vector-store.ts`

**Out of scope**: Alternate index backends (none exist; the pipeline and
backend split and any external provider are specified in
`pluggable-knowledge-store`). How chunks get written by ingest jobs
(`knowledge-ingest-pipeline`). The ingestion CLI scripts (operational
tooling, not a runtime contract).

---

## Changes in this revision

Rewritten from the code on 2026-10-15. Corrected: memory and initiative
namespaces are team-scoped; the lexical leg is Postgres full-text search
(`ts_rank` over `lexical_tsv`), not BM25; two Voyage models are in use, not
one, plus the `rerank-2.5` reranker; `spec_compare` is worker-level, reads the
caller's `docs` and `code` namespaces and has no namespace setting; the corpus
list now matches `Corpus` and `CORPORA`. AC-1 to AC-17 keep their ids (AC-16
is reversed to match the access change); AC-18 to AC-22 are new.
