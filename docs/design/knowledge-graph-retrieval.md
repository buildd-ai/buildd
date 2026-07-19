# Recency-Aware + Entity/Graph Retrieval for KnowledgeStore

**Status:** Draft spec — awaiting approval before any implementation task is created
**Author:** Agent  
**Date:** 2026-06-25  
**Scope:** `packages/core/knowledge-store/` and surrounding MCP tooling  
**Related:** `docs/design/knowledge-tool-surface.md` (MCP tool surface that sits on top of this retrieval layer)

---

## Table of Contents

1. [Current State (Recon)](#1-current-state-recon)
2. [Problem Statement](#2-problem-statement)
3. [Design Overview — Three Additive Layers](#3-design-overview)
4. [Layer 1 — Recency & Authority Reranking](#4-layer-1-recency--authority-reranking)
5. [Layer 2 — Entities](#5-layer-2-entities)
6. [Layer 3 — Graph Edges & Graph-Augmented Rerank](#6-layer-3-graph-edges--graph-augmented-rerank)
7. [Schema Migrations (DDL Sketches)](#7-schema-migrations-ddl-sketches)
8. [Agent-Metadata MCP Contract](#8-agent-metadata-mcp-contract)
9. [SCIP / ast-grep Integration Plan](#9-scip--ast-grep-integration-plan)
10. [Phased Rollout](#10-phased-rollout)
11. [Open Questions & Risks](#11-open-questions--risks)

---

## 1. Current State (Recon)

### 1.1 `knowledge_chunks` Schema (confirmed)

```sql
CREATE TABLE knowledge_chunks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id        text NOT NULL,          -- stable external id (memoryId, "task:{id}", "path#line")
  namespace        text NOT NULL,          -- "{workspaceId}:{corpus}" or "{teamId}:memory"
  corpus           text NOT NULL,          -- memory|code|docs|task|artifact|pr|plan|session
  source_type      text NOT NULL,
  source_path      text,                   -- repo-relative file path (code/docs only)
  source_url       text,                   -- deep link
  content          text NOT NULL,
  lexical_text     text,                   -- BM25-optimized text (title+content for memories)
  embedding        vector(1024),           -- Voyage voyage-code-3 / voyage-3-lite
  embedding_model  text,
  metadata         jsonb NOT NULL DEFAULT '{}',
  content_hash     text,                   -- SHA-256 for idempotency
  updated_at       timestamp with time zone NOT NULL DEFAULT now()
);
-- Indexes:
-- UNIQUE  (namespace, source_id)           → idempotent upsert
-- B-tree  (namespace)
-- B-tree  (namespace, content_hash)
-- HNSW    (embedding vector_cosine_ops)    → ANN vector search
-- GIN     to_tsvector('english', coalesce(lexical_text, content))  → BM25
```

**Key observations:**
- No `created_at`. `updated_at` reflects when the row was last written, not when the source event occurred.
- No `source_ts` (source event timestamp). No `is_current`. No `superseded_by`.
- No entity or graph columns.
- `metadata` jsonb is present but carries only loose agent-written keys (phase, taskId, memoryId, etc.) — no normalized entity references.

### 1.2 Retrieval Path (confirmed)

**`PgVectorStore.query(namespace, params)` — three modes:**

1. **Vector** (`mode='vector'`): Asymmetric cosine similarity via pgvector (`embedding <=> vec`). Score = `1 − cosine_distance`. Candidates fetched with `LIMIT topK × 2`.

2. **Lexical** (`mode='lexical'`): `to_tsvector('english', coalesce(lexical_text, content)) @@ websearch_to_tsquery('english', ?)` + `ts_rank`. Standard BM25 ranking.

3. **Hybrid** (`mode='hybrid'`, default): Both arms run independently to `LIMIT topK × 2` each. Scores merged via **Reciprocal Rank Fusion** (k=60 per the original paper):
   ```
   rrfScore(doc) = Σ 1 / (k + rank_i)
   ```
   The fused list is then re-fetched for full rows.

4. **Optional cross-encoder reranker** (`VoyageReranker rerank-2.5`): Applied as `_finalize` after RRF. When present, retrieves a wider candidate pool (`min(topK × 5, 100)`) and applies the cross-encoder to the full text. When absent, RRF order stands.

**No recency, authority, or graph signals exist anywhere in the pipeline.**

### 1.3 Ingest Path (confirmed)

**`ingest-knowledge.ts` → `ingestFiles()` → `fileToChunks()` → `PgVectorStore.upsert()`**

- Walks a directory, classifies by extension into `code` / `docs` corpora.
- Chunking: line-window splitter with overlap (1600/200 chars for code, 1200/150 for docs). Markdown gets heading-aware chunking; heading path is prefixed to `lexical_text`.
- Chunk id: `path#startLine` — stable across re-ingests.
- Re-runnable: `deleteBySource(namespace, {sourcePath})` clears prior chunks before re-chunking.
- **`stat.size` is read but `stat.mtime` is NOT captured.** No file-level timestamp is recorded.
- No git commit time is captured. Source timestamps are completely absent.

**Card mirroring (mcp-tools.ts → `mirrorWorkProduct`):**

Agent work products are auto-indexed as single-chunk "cards":
- `complete_task` → corpus `task`, id `task:{taskId}`
- `create_pr` → corpus `pr`, id `pr:{prNumber}`
- `create_artifact` → corpus `artifact`, id `artifact:{artifactId}`
- `approve_plan` → corpus `plan`, id `plan:{taskId}`

None of these record the source event timestamp (task completion time, PR merged_at, etc.).

### 1.4 Memory Mirroring (confirmed)

On `buildd_memory action=save/update`:
```ts
// Upserted into {teamId}:memory namespace
{
  id: memory.id,
  content: memory.content,
  lexicalText: `${memory.title}\n\n${memory.content}`,
  sourceType: 'memory',
  metadata: { memoryId, type, tags, files, project }
}
```
`memory.createdAt` and `memory.updatedAt` from the MemoryService are **not stored** in the chunk. Recency-based reranking of memories is therefore impossible today.

---

## 2. Problem Statement

The current retrieval system is **pure relevance**: RRF(vector, lexical) with an optional cross-encoder. It has three structural gaps:

| Gap | Impact |
|-----|--------|
| No recency signal | A spec written last week does not outrank a superseded spec from six months ago. A completed task outcome is as relevant as an abandoned one. |
| No authority signal | A canonical spec chunk scores the same as an ephemeral task note about the same topic. |
| No supersession tracking | When a new spec replaces an old one, both are returned — with no way to know which is current. |
| No entity/relationship graph | "What does the auth middleware implement?" requires retrieving both the spec and the code — there is no edge connecting them. Spreading-activation over related nodes is impossible. |

---

## 3. Design Overview

Three additive layers, each independently shippable. Later layers build on earlier ones but do not require them to be complete first.

```
Query
  │
  ▼
[RRF: vector + lexical]  ← unchanged candidate generator
  │
  ▼ Layer 1
[Recency × Authority rerank]
  │
  ▼ Layer 3
[Graph expansion + graphProximity boost]
  │
  ▼
[Cross-encoder reranker]  ← Voyage rerank-2.5, unchanged
  │
  ▼
[Superseded chunks dropped]
  │
  ▼
Results
```

**Hard constraint (non-negotiable):** No LLM in the ingestion or edge-building pipeline. All edge construction and entity extraction is deterministic code. The only semantic signal from a model comes from agents emitting structured metadata as a byproduct of work they already do (task outcomes, memory saves). The deterministic edge builder consumes that metadata via rules.

---

## 4. Layer 1 — Recency & Authority Reranking

### 4.1 New Columns on `knowledge_chunks`

Three new columns are added (see §7 for full DDL):

| Column | Type | Purpose |
|--------|------|---------|
| `source_ts` | `timestamp with time zone` | When the source event occurred (not when it was indexed). Per-corpus fill strategy defined below. |
| `is_current` | `boolean NOT NULL DEFAULT true` | False when superseded. Dropped from normal queries. |
| `superseded_by` | `text` | `source_id` of the chunk that superseded this one. |

### 4.2 `source_ts` Fill Strategy (deterministic, no LLM)

| Corpus | Source of timestamp |
|--------|-------------------|
| `code` | `git log --format=%cI -1 -- <path>` (committed time for the file). Falls back to `stat.mtime` if git is unavailable. |
| `docs` | Front-matter `date:` / `updated:` field if present; otherwise `git log` committed time; fallback `stat.mtime`. |
| `spec` | Same as docs. |
| `pr` | `merged_at` from GitHub API (available in `create_pr` MCP action context). Falls back to `now()`. |
| `task` | Task `completedAt` (available in `complete_task` action). |
| `artifact` | Artifact `createdAt` (available in `create_artifact` action). |
| `memory` | `memory.updatedAt` from the MemoryService response (already returned in the `save` / `update` response). |
| `plan` | Task `updatedAt` at plan-approval time. |

**Backfill for existing rows:** A one-shot migration script reads `metadata.taskId` / `metadata.prNumber` / `source_path` from existing rows and populates `source_ts` retroactively. Rows where no source timestamp can be determined are set to `updated_at` (conservative, avoids null).

### 4.3 Corpus Authority Map

A static map, configurable but not runtime-dynamic. Default values (higher = more authoritative):

```ts
const CORPUS_AUTHORITY: Record<Corpus, number> = {
  spec:     1.0,   // canonical product spec — highest authority
  docs:     0.9,   // curated documentation
  code:     0.8,   // source of truth for implementation
  plan:     0.6,   // approved plans (pre-implementation)
  pr:       0.5,   // implementation records
  task:     0.4,   // task outcomes (ephemeral)
  artifact: 0.4,   // task artifacts
  memory:   0.5,   // team memories (mixed authority)
  session:  0.2,   // session context — lowest authority
};
```

`spec` is a sub-corpus of `docs` (same ingest path but a higher-authority label applied by the ingest script via a path convention: `docs/SPEC.md` or `docs/design/**`). The `Corpus` type is widened to include `'spec'` — no DB migration needed (column is plain `text`).

### 4.4 Recency Decay Function

```
recencyDecay(source_ts, halfLife_days) = 2^(−age_days / halfLife_days)
```

Default half-lives per corpus:

| Corpus | Half-life (days) | Rationale |
|--------|-----------------|-----------|
| `spec` | 365 | Specs change slowly; a 1-year-old spec is still ~50% as fresh |
| `docs` | 180 | Docs drift moderately |
| `code` | 90  | Code evolves faster |
| `plan` | 60  | Plans are pre-implementation; stale quickly |
| `pr` | 45  | PRs reference past work |
| `memory` | 120 | Team knowledge has medium decay |
| `task` | 30  | Task outcomes are most time-bound |
| `artifact` | 30 | Same as tasks |
| `session` | 7   | Session context is highly ephemeral |

### 4.5 Combined Score Formula

After RRF produces `rrfScore ∈ (0, 1]`:

```
finalScore = rrfScore × corpusAuthority[corpus] × recencyDecay(source_ts, halfLife[corpus])
```

This is applied in-process after `reciprocalRankFusion()`, before the optional cross-encoder reranker. Implementation: a new `applyRecencyAuthority(results, now)` function in `pg-vector-store.ts` that mutates `.score` on each `QueryResult`.

**When `source_ts` is NULL**, `recencyDecay = 1.0` (no penalty — conservative fallback).

### 4.6 Supersession Rule

Two chunks in the same namespace are related by supersession when ALL of the following hold:

1. They share the same `entity_key` (introduced in Layer 2; for Layer 1, use `source_path` as a proxy for code/docs chunks, and a `spec_key` metadata field for spec chunks).
2. The newer chunk's `corpus` has equal or higher authority than the older one.
3. The newer chunk's `source_ts > older chunk's source_ts`.

On upsert (or as a post-ingest step), the system evaluates: for each chunk with a non-null `source_path` (code/docs), query for other chunks with the same `namespace + source_path` and lower `source_ts`. Mark those older chunks `is_current = false`, `superseded_by = <new source_id>`.

**Query filter:** Normal retrieval adds `AND is_current = true`. A `history: true` query param (future API) skips this filter.

---

## 5. Layer 2 — Entities

### 5.1 Entity Extraction (deterministic, no LLM)

Entity extraction runs at ingest time for code/docs and at card-building time for task/pr/memory chunks. All extraction is deterministic — no model calls.

**Automatic entity types extracted from chunk content/context:**

| Entity kind | Extraction method | Example `key` |
|-------------|------------------|--------------|
| `file` | source_path of the chunk | `apps/web/src/app/api/workers/claim/route.ts` |
| `symbol` | SCIP output (§9) — exported functions, classes, types | `packages/core/knowledge-store/pg-vector-store#PgVectorStore` |
| `import` | SCIP occurrence of kind=REFERENCE to another file's symbol | (derived from SCIP edges, not a standalone entity) |
| `heading` | Markdown `##` headings in docs/spec chunks | `docs/design/SPEC.md#Retrieval Path` |
| `pr` | `#\d+` reference in text | `pr#987` |
| `task` | UUID pattern matching known task-id format | `task:c21dfeb7-...` |
| `mission` | Mission id in metadata | `mission:abc123` |
| `wikilink` | `[[Target]]` in markdown | `target-slug` |

**Agent-supplied entity types** (via extended MCP params — §8):

| Entity kind | Who supplies | Example |
|-------------|-------------|---------|
| `concept` | Agent | `"memory namespace alignment"` |
| `feature` | Agent | `"knowledge graph retrieval"` |
| `component` | Agent | `"PgVectorStore"` (semantic, may differ from SCIP symbol) |

### 5.2 `knowledge_entities` Table

```sql
CREATE TABLE knowledge_entities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  text NOT NULL,     -- or teamId for memory-scoped entities
  kind          text NOT NULL,     -- file|symbol|heading|pr|task|mission|concept|feature|component
  key           text NOT NULL,     -- canonical key (stable, unique per workspace+kind)
  canonical_name text NOT NULL,   -- human-readable display name
  attributes    jsonb NOT NULL DEFAULT '{}',
  first_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at  timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, key)
);
CREATE INDEX knowledge_entities_workspace_kind_idx ON knowledge_entities (workspace_id, kind);
CREATE INDEX knowledge_entities_key_trgm_idx ON knowledge_entities USING gin (key gin_trgm_ops);
```

### 5.3 `entity_aliases` Table

Seeded from SCIP monikers, file basenames, class names, and confirmed prior references. Enables fuzzy resolution without LLM.

```sql
CREATE TABLE entity_aliases (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id  uuid NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
  alias      text NOT NULL,
  source     text NOT NULL DEFAULT 'system',  -- 'scip'|'system'|'agent'|'confirmed'
  UNIQUE (entity_id, alias)
);
CREATE INDEX entity_aliases_alias_trgm_idx ON entity_aliases USING gin (alias gin_trgm_ops);
```

### 5.4 `pending_entity_refs` Table

Unresolved entity references from agent-supplied metadata queue here for auto-heal or one-tap confirm.

```sql
CREATE TABLE pending_entity_refs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  raw_ref      text NOT NULL,        -- the unresolved string the agent wrote
  kind_hint    text,                 -- kind the agent asserted
  source_chunk_id text,             -- source_id of the chunk that produced this ref
  source       text,                 -- 'agent'|'ingest'
  created_at   timestamp with time zone NOT NULL DEFAULT now(),
  resolved_at  timestamp with time zone,
  resolved_entity_id uuid REFERENCES knowledge_entities(id)
);
CREATE INDEX pending_entity_refs_workspace_idx ON pending_entity_refs (workspace_id, resolved_at);
```

### 5.5 `chunk_entities` Junction Table

Links a chunk to its extracted/resolved entities.

```sql
CREATE TABLE chunk_entities (
  chunk_source_id text NOT NULL,    -- knowledge_chunks.source_id
  namespace       text NOT NULL,    -- knowledge_chunks.namespace
  entity_id       uuid NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'mentions',  -- 'defines'|'references'|'mentions'
  PRIMARY KEY (chunk_source_id, namespace, entity_id, role)
);
CREATE INDEX chunk_entities_entity_idx ON chunk_entities (entity_id);
```

### 5.6 Entity Resolution (Deterministic Resolver, Three Tiers)

1. **Exact match** on `entity.key` (kind + normalized key string).
2. **Alias table lookup** — `entity_aliases.alias = input` (case-insensitive). Seeded from SCIP monikers, file basenames, class names, confirmed prior refs.
3. **pg_trgm fuzzy** — `alias gin_trgm_ops` similarity search returning CANDIDATES (not auto-bind). Candidates returned to agent as `ambiguous` refs.

Unresolved refs → `pending_entity_refs` queue.

**Write-time validation feedback:** MCP `buildd_memory action=save` (and `complete_task`) returns:
```json
{
  "bound":       3,   // entity refs auto-resolved via exact/alias
  "ambiguous":   1,   // refs that matched multiple candidates (listed)
  "unresolved":  0    // refs with no match (queued in pending_entity_refs)
}
```
This lets agents correct ambiguous refs in-turn.

**Confirm-and-learn:** When a `pending_entity_ref` is later resolved (via auto-heal on new ingest OR via one-tap confirm in the "needs you" queue), the system writes an alias entry for the raw ref string — so identical future refs auto-bind.

---

## 6. Layer 3 — Graph Edges & Graph-Augmented Rerank

### 6.1 `knowledge_edges` Table

```sql
CREATE TABLE knowledge_edges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    text NOT NULL,
  from_entity_id  uuid NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
  to_entity_id    uuid NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
  type            text NOT NULL,   -- edge type catalog below
  weight          real NOT NULL DEFAULT 1.0,
  source_chunk_id text,            -- the chunk that produced this edge (for provenance)
  rule            text NOT NULL,   -- which rule/extractor produced this edge
  created_at      timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, from_entity_id, to_entity_id, type)
);
CREATE INDEX knowledge_edges_from_idx ON knowledge_edges (workspace_id, from_entity_id);
CREATE INDEX knowledge_edges_to_idx   ON knowledge_edges (workspace_id, to_entity_id);
```

### 6.2 Edge Type Catalog (Deterministic Rules)

All edge construction is deterministic code. No LLM.

| Edge type | Rule | Source |
|-----------|------|--------|
| `imports` | SCIP: file A has import occurrence pointing to file B's symbol | SCIP indexer |
| `defines` | SCIP: file A has a definition occurrence for symbol S | SCIP indexer |
| `references` | SCIP: file A has a reference occurrence to symbol S defined in file B | SCIP indexer |
| `produced` | PR changed files list (from GitHub diff) → PR entity `produced` file entities | `create_pr` card + GitHub diff |
| `implements` | Path convention: `src/foo.ts` implements `docs/spec/foo.md` when both exist and share normalized basename. Also from agent assertion (`implements` relation). | Ingest path convention + agent |
| `supersedes` | Newer chunk's entity_key matches older chunk's entity_key AND newer has higher corpus authority AND newer source_ts > older source_ts | Supersession rule (§4.6) |
| `references_doc` | PR body / task description contains `#PR`, wikilink `[[X]]`, or relative link `./path` → entity | Regex extraction from text |
| `relates_to` | Agent-asserted relation with type `relates_to` | Agent-supplied metadata (§8) |
| `outcome_of` | Task card → mission entity (via `missionId` in metadata) | Card builder |
| `part_of` | Heading entity → document entity | Markdown heading extraction |

**Edge weight defaults:** Most edges weight `1.0`. `implements` = `0.9`. `references` = `0.5`. `relates_to` (agent-asserted) = `0.7`. Supersedes edges = `1.0` (directional; traversal drops the superseded end).

### 6.3 Deterministic Edge Builder

A pure function (no I/O beyond the injected entity resolver):

```ts
interface EdgeBuilderInput {
  chunk: UpsertChunk;
  corpus: Corpus;
  workspaceId: string;
  scipOccurrences?: ScipOccurrence[];  // optional; from SCIP index
  prDiff?: string[];                   // optional; changed files list
  agentRelations?: AgentRelation[];    // optional; from §8
}

interface EdgeBuilderOutput {
  entities: EntityUpsert[];
  edges: EdgeUpsert[];
  pendingRefs: PendingRef[];
}

function buildEdges(input: EdgeBuilderInput): EdgeBuilderOutput { /* ... */ }
```

The edge builder is **idempotent**: calling it twice on the same input produces the same entity/edge set. All writes are `INSERT ... ON CONFLICT DO UPDATE` or `DO NOTHING`.

### 6.4 Graph-Augmented Retrieval

After RRF produces a seed set of candidate chunks:

1. **Seed → entity mapping:** For each candidate chunk, look up its `chunk_entities` to find seed entities.
2. **1-hop expansion:** Query `knowledge_edges WHERE from_entity_id IN (seed_entities) AND type NOT IN ('supersedes')` to find neighbor entities. Filter out superseded (`is_current = false`) chunks.
3. **Expand candidate set:** For each neighbor entity, add its highest-scoring non-superseded chunk to the candidate set (if not already present). Cap expansion to `topK × 2` total.
4. **Graph proximity score:** For each expanded chunk, `graphProximity = MAX(edge.weight for edges connecting it to any seed)`. For seed chunks themselves, `graphProximity = 1.0`.
5. **Final score formula:**
   ```
   finalScore = rrfScore × corpusAuthority × recencyDecay × graphProximity
   ```
   Expanded chunks that were not in the original RRF result get `rrfScore` inherited from the connecting seed chunk (discounted by 0.7 to signal indirection).
6. **Superseded chunks dropped** (those with `is_current = false`) unless `params.history = true`.
7. Results sorted by `finalScore DESC`, trimmed to `topK`, then passed to optional cross-encoder.

**Spreading-activation depth:** Fixed at 1 hop for Phase 1 of Layer 3. 2-hop expansion is a future option but risks recall explosion.

---

## 7. Schema Migrations (DDL Sketches)

These are sketches for the implementation task. Exact column ordering and constraint names will be settled at migration time. All are additive — no existing columns are dropped or renamed.

### Migration A — Layer 1 columns on `knowledge_chunks`

```sql
ALTER TABLE knowledge_chunks
  ADD COLUMN source_ts    timestamp with time zone,
  ADD COLUMN is_current   boolean NOT NULL DEFAULT true,
  ADD COLUMN superseded_by text;

-- Index for supersession queries
CREATE INDEX knowledge_chunks_entity_recency_idx
  ON knowledge_chunks (namespace, is_current, source_ts DESC);
```

### Migration B — Layer 2: entity tables

```sql
-- Require pg_trgm extension (already available on Neon)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE knowledge_entities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  text NOT NULL,
  kind          text NOT NULL,
  key           text NOT NULL,
  canonical_name text NOT NULL,
  attributes    jsonb NOT NULL DEFAULT '{}',
  first_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at  timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, key)
);
CREATE INDEX knowledge_entities_workspace_kind_idx ON knowledge_entities (workspace_id, kind);
CREATE INDEX knowledge_entities_key_trgm_idx ON knowledge_entities USING gin (key gin_trgm_ops);

CREATE TABLE entity_aliases (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id  uuid NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
  alias      text NOT NULL,
  source     text NOT NULL DEFAULT 'system',
  UNIQUE (entity_id, alias)
);
CREATE INDEX entity_aliases_alias_trgm_idx ON entity_aliases USING gin (alias gin_trgm_ops);

CREATE TABLE chunk_entities (
  chunk_source_id text NOT NULL,
  namespace       text NOT NULL,
  entity_id       uuid NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'mentions',
  PRIMARY KEY (chunk_source_id, namespace, entity_id, role)
);
CREATE INDEX chunk_entities_entity_idx ON chunk_entities (entity_id);

CREATE TABLE pending_entity_refs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       text NOT NULL,
  raw_ref            text NOT NULL,
  kind_hint          text,
  source_chunk_id    text,
  source             text,
  created_at         timestamp with time zone NOT NULL DEFAULT now(),
  resolved_at        timestamp with time zone,
  resolved_entity_id uuid REFERENCES knowledge_entities(id)
);
CREATE INDEX pending_entity_refs_workspace_idx ON pending_entity_refs (workspace_id, resolved_at);
```

### Migration C — Layer 3: edges table

```sql
CREATE TABLE knowledge_edges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    text NOT NULL,
  from_entity_id  uuid NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
  to_entity_id    uuid NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
  type            text NOT NULL,
  weight          real NOT NULL DEFAULT 1.0,
  source_chunk_id text,
  rule            text NOT NULL,
  created_at      timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, from_entity_id, to_entity_id, type)
);
CREATE INDEX knowledge_edges_from_idx ON knowledge_edges (workspace_id, from_entity_id);
CREATE INDEX knowledge_edges_to_idx   ON knowledge_edges (workspace_id, to_entity_id);
```

---

## 8. Agent-Metadata MCP Contract

### 8.1 Extended `buildd_memory action=save/update`

New optional fields added to the existing params object. Backward-compatible — all new fields are optional.

```ts
interface SaveMemoryInput {
  // existing fields unchanged
  type: string;
  title: string;
  content: string;
  project?: string;
  tags?: string[];
  files?: string[];
  source?: string;

  // NEW — Layer 2+
  entities?: EntityRef[];       // entities this memory mentions / defines
  relations?: RelationRef[];    // directed edges to assert
  supersedes?: string[];        // entity keys OR source_ids this memory supersedes
}

interface EntityRef {
  kind: 'concept' | 'feature' | 'component' | 'file' | 'task' | 'pr' | 'mission';
  ref: string;    // loose name the agent wrote (resolver binds to canonical)
  role?: 'defines' | 'references' | 'mentions';  // default: 'mentions'
}

interface RelationRef {
  from: string;   // loose entity ref (agent-written; resolver binds)
  type: 'implements' | 'supersedes' | 'references_doc' | 'relates_to' | 'outcome_of';
  to: string;     // loose entity ref
  weight?: number; // 0.0–1.0; default per edge-type catalog
}
```

**Response shape:** The save/update response gains a new `entityBinding` field:
```json
{
  "memory": { ... },
  "entityBinding": {
    "bound":      3,
    "ambiguous":  [{ "ref": "PgStore", "candidates": ["PgVectorStore", "PgStoreLegacy"] }],
    "unresolved": ["some-unknown-thing"]
  }
}
```

### 8.2 Extended `complete_task`

```ts
interface CompleteTaskParams {
  // existing fields unchanged
  summary?: string;
  error?: string;

  // NEW — Layer 2+
  entities?: EntityRef[];
  relations?: RelationRef[];
  supersedes?: string[];
}
```

Same `entityBinding` feedback in the response.

### 8.3 What agents should NOT supply

- Canonical symbol names (SCIP provides these; agent writes the loose human name).
- File paths (auto-bound from `files[]` + diff context).
- PR numbers, task/mission IDs (auto-bound from context).
- The entity `key` format (the resolver normalizes; agent writes display-style names).

Agents supply **semantic glue** (concept-level entities and relations) that deterministic parsing cannot infer. Everything that can be bound from code structure, file lists, or metadata is bound automatically — the agent only fills the gap.

### 8.4 Catalog vocabulary pre-seeding

Before an agent writes metadata for a task, the system injects into the task context (claim route or mission context builder) a compact **entity catalog** for the subgraph touched by that task: the file entities corresponding to the task's changed-file list, their SCIP-extracted symbols, and any recently seen entities linked to those files. This ensures agents pick real names from the catalog rather than inventing new strings.

---

## 9. SCIP / ast-grep Integration Plan

### 9.1 Tool Selection Rationale

| Tool | Use | Why |
|------|-----|-----|
| **scip-typescript** | Precise def/ref/import graph with canonical IDs for the TypeScript/Bun monorepo | SCIP emits stable symbol monikers + def-vs-reference occurrences — both the edge source AND the canonical-name backbone. Supports the `tsconfig.json`-based build used by this repo. |
| **@ast-grep/napi** | Language-agnostic no-build extraction for files SCIP doesn't cover (shell scripts, SQL, exotic types) | Tree-sitter under the hood; single napi dep; rule-based extraction; no build required. |
| **ctags** | Cheap fallback for truly exotic files | Universal, no build. Output: name+kind+file only (no import graph). |

**Explicitly excluded:** LSP-runtime approaches (e.g. multilspy) — too heavy/stateful for an ingest worker that must be stateless and restartable.

### 9.2 SCIP Fit Check for This Monorepo

The repo uses Turborepo with `packages/` and `apps/`, each with its own `tsconfig.json`. `scip-typescript` accepts either:
- Per-package invocation: `scip-typescript --project packages/core/tsconfig.json`
- Workspace-level invocation: `scip-typescript --project tsconfig.json` (if a root tsconfig with `references:` exists)

**Confirmed fit conditions (to verify at implementation time):**
1. All packages have valid `tsconfig.json` files.
2. The monorepo root has a composite `tsconfig.json` or the ingest worker can enumerate per-package configs.
3. `scip-typescript` version ≥ 0.3 supports the `paths` and `baseUrl` compiler options used in this repo.

**SCIP output format:** A single `.scip` file (binary protobuf) containing:
- `Document` per source file
- `Occurrence` records: each has a `symbol` (moniker), a `range` (line/col), and `symbol_roles` (DEFINITION | REFERENCE | etc.)

**Mapping to `knowledge_entities`:**
- Each DEFINITION occurrence → one `knowledge_entities` row with `kind='symbol'`, `key = scip_moniker`, `canonical_name = short_name`
- Each document → one `knowledge_entities` row with `kind='file'`, `key = repo_relative_path`

**Mapping to `knowledge_edges`:**
- DEFINITION occurrence in file A → edge `(file:A, defines, symbol:S)`, rule=`scip:definition`
- REFERENCE occurrence in file A to symbol S defined in file B → edge `(file:A, references, symbol:S)` + `(file:A, imports, file:B)` (derived), rule=`scip:reference`

### 9.3 Running SCIP in the Ingest Worker

**Invocation location:** `packages/core/scripts/ingest-knowledge.ts` (or a new sibling `ingest-entities.ts`). Run as a child process via `Bun.spawn(['scip-typescript', ...])`.

**Trigger:** Runs once per workspace ingest, after the file-chunking pass. Output is consumed immediately (`.scip` file written to a temp dir, parsed, discarded).

**SCIP index → edge builder flow:**
```
1. Run scip-typescript → /tmp/index.scip
2. Parse SCIP protobuf → Map<filePath, ScipOccurrence[]>
3. For each code chunk already upserted:
   a. Look up occurrences by source_path
   b. Call buildEdges({ chunk, scipOccurrences, ... })
   c. Upsert entities + edges
4. Delete /tmp/index.scip
```

**ast-grep fallback:**
- For files SCIP cannot parse (e.g. `.sh`, `.sql`), run `@ast-grep/napi` with language-specific rules to extract top-level names.
- Rules are simple: `kind: function_declaration | export_statement` → entity of kind `symbol`.

### 9.4 Build Cost Mitigation

SCIP requires a buildable TypeScript project (type-checking pass). On a repo of this size (~hundreds of `.ts` files), `scip-typescript` typically runs in 30–90 seconds. Mitigations:

1. **Run in CI, not on every ingest.** The ingest worker can consume a pre-built SCIP index committed to the repo (or uploaded to R2) by CI after each push to `dev`.
2. **Cache by commit SHA.** If `HEAD` SHA matches the last indexed SHA, skip SCIP re-indexing.
3. **Per-package scoping.** If a PR only touches `packages/core`, only re-index that package.
4. **Graceful degradation.** If SCIP fails (network, build error), fall back to ast-grep for entity extraction. Edges derived from SCIP are simply absent for that run — not an error.

---

## 10. Phased Rollout

Each phase is independently shippable. A later phase can be abandoned or deferred without undoing earlier phases.

### Phase 1 — Recency & Authority (Layer 1)

**Scope:** Migration A + `source_ts` fill + `is_current` + recency/authority rerank function.

**Changes:**
- DB: `ALTER TABLE knowledge_chunks ADD COLUMN source_ts / is_current / superseded_by` (Migration A)
- `ingestFiles()`: capture `stat.mtime` or git committed time → pass as `source_ts` in `UpsertChunk`
- `UpsertChunk` type: add optional `sourceTs?: Date | null`
- `PgVectorStore.upsert()`: write `source_ts` when provided
- `mirrorWorkProduct()` (mcp-tools.ts): pass `completedAt` / `mergedAt` / `updatedAt` as `sourceTs`
- New `applyRecencyAuthority(results, now)` function in `pg-vector-store.ts`
- Update `PgVectorStore.query()` to call `applyRecencyAuthority` after RRF
- Normal queries filter `AND is_current = true`
- Supersession rule applied in post-upsert step for `source_path`-keyed code/docs chunks
- Backfill script: populate `source_ts` from existing metadata / `updated_at`

**Acceptance criteria:**
- A query for "knowledge store architecture" returns the most recent spec chunk ranked above an older task outcome about the same topic.
- Superseded code file chunks are absent from results after re-ingest.

**Ship as:** Single PR targeting `dev`.

### Phase 2 — Entities (Layer 2)

**Scope:** Migrations B + entity extractor + `chunk_entities` population + MCP contract extension + resolver + pending_entity_refs queue.

**Changes:**
- DB: Migrations B (entity tables)
- New `entity-extractor.ts` module: deterministic extraction of file/heading/pr/task/mission entities from chunk content
- New `entity-resolver.ts` module: three-tier resolver (exact → alias → pg_trgm candidates)
- Extend `UpsertChunk` type: add `entities?: EntityRef[]`, `relations?: RelationRef[]`
- Update `buildTaskCard`, `buildPrCard` etc. in `cards.ts` to auto-extract entities from metadata (taskId → task entity, prNumber → pr entity, missionId → mission entity)
- Extend `handleMemoryAction` save/update: accept new `entities/relations/supersedes` params, return `entityBinding`
- Extend `complete_task`: accept new params, return `entityBinding`
- Entity catalog injection into task context (claim route / mission context builder)

**Acceptance criteria:**
- After saving a memory with `entities: [{kind:'feature', ref:'knowledge graph retrieval'}]`, the entity appears in `knowledge_entities`.
- A task card auto-creates `task:{taskId}` entity linked to its `mission:{missionId}` entity.
- An unresolved entity ref appears in `pending_entity_refs`.

**Ship as:** Single PR (may be split into two: schema + extractor, then MCP contract).

### Phase 3 — Graph Edges & Graph-Augmented Rerank (Layer 3)

**Scope:** Migration C + SCIP integration + edge builder + graph-augmented rerank in query path.

**Changes:**
- DB: Migration C (edges table)
- New `edge-builder.ts`: deterministic edge builder consuming SCIP output + agent relations
- SCIP runner integration in `ingest-knowledge.ts`
- ast-grep fallback for non-TS files
- `PgVectorStore.query()` extended: 1-hop graph expansion + `graphProximity` scoring
- CI step: run `scip-typescript` post-build, upload index to R2 or store SHA for cache invalidation
- `buildEdges` registered as post-ingest step

**Acceptance criteria:**
- After ingesting the codebase, querying "what implements PgVectorStore?" returns the code file entity and its linked spec chunk via graph expansion.
- A PR entity is connected to the files it changed via `produced` edges.
- Graph expansion adds at most one additional query (single 1-hop lookup) beyond the existing RRF retrieval.

**Ship as:** Multiple PRs (SCIP runner, edge builder, query path extension, CI step).

---

## 11. Open Questions & Risks

### Q1 — SCIP build feasibility

**Risk:** `scip-typescript` may fail on certain monorepo path configs (path aliases, Bun-specific module resolution, or missing composite tsconfig). The worker would fall back to ast-grep, losing precise import/definition edges.

**Mitigation:** Validate scip-typescript against this repo locally before starting Phase 3. If it fails, ast-grep + regex heuristics cover the 80% case (top-level exports, import statements). Document the degraded mode explicitly.

### Q2 — Backfill of `source_ts` for existing rows

**Risk:** Many existing rows have no source timestamp in metadata. The backfill script can recover `updated_at` (conservative) and use the GitHub API for PRs, but code/docs rows will largely be stamped with `updated_at` (index time, not commit time).

**Mitigation:** For code/docs, run `git log --format=%cI -1 -- <source_path>` during backfill. This requires a git checkout of the repo during the backfill script, which is feasible as a one-shot admin task. Document that backfill results are approximate.

### Q3 — Namespace partitioning for entities

**Risk:** Memory-corpus chunks are `{teamId}:memory` scoped (team-level), while code/docs/task chunks are `{workspaceId}:{corpus}` scoped (workspace-level). Entity tables use a single `workspace_id` column — but memory entities are team-scoped.

**Mitigation:** Use the column as a generic "scope id" that can be either a team or workspace id. The resolver must know whether to look up by `teamId` or `workspaceId` based on corpus. Document this dual-scoping clearly. Consider a future `scope_type` column (`team|workspace`) for clarity.

### Q4 — Agent entity name quality

**Risk:** Agents may write inconsistent loose refs ("pgvectorstore", "PgVectorStore", "the vector store") for the same entity, leading to many unresolved refs in `pending_entity_refs`.

**Mitigation:** Entity catalog pre-seeding (§8.4) is the primary defense. The alias table auto-heals once one form is confirmed. pg_trgm fuzzy matching returns candidates for human confirmation. The system degrades gracefully — unresolved refs are queued, not lost.

### Q5 — Query latency impact

**Risk:** Graph expansion adds a second query (1-hop edge lookup + chunk fetch for expanded entities). This adds ~5–15ms on a warm Neon connection.

**Mitigation:** Graph expansion is gated behind a `useGraph: boolean` query param (default `true` in Phase 3, off in Phases 1–2). The entity lookup is a single indexed query on `knowledge_edges` (from_entity_id IN (...)) — well within the latency budget. Profile before and after Phase 3 shipping.

### Q6 — Cross-encoder interaction

**Risk:** The existing Voyage `rerank-2.5` cross-encoder reranker is applied after RRF. With graph expansion adding new candidates, the reranker sees a larger input set (potentially `topK × 5 + expansion`), increasing latency and cost.

**Mitigation:** Graph-expanded chunks are added to the candidate pool BEFORE the cross-encoder runs, so they compete on equal footing. Cap total candidates at `min(topK × 5, 150)` to bound reranker cost. The reranker already handles 100-candidate pools — 150 is a marginal increase.

### Q7 — `spec` as a corpus value

**Risk:** The `Corpus` TypeScript union type does not currently include `'spec'`. Adding it widens the type but requires no DB migration (column is plain `text`). However, all switch/match statements over `Corpus` would need updating.

**Mitigation:** Add `'spec'` to the union in Phase 1 and audit all switch statements. This is a low-risk change but must not be forgotten.

---

*End of spec. This document should be approved before any implementation task is created.*
