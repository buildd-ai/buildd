# KnowledgeStore

Hybrid semantic + lexical retrieval over buildd's knowledge: memories, code, docs,
and spec. Designed as a swappable interface (same pattern as `AgentBackend`) so the
backing store can change with zero call-site churn.

## Architecture

```
buildd_memory (MCP)  ──save/update/delete──►  KnowledgeStore.upsert/delete
buildd_memory query_knowledge ──────────────►  KnowledgeStore.query
ingest job (runner-claimed) ─────────────────►  KnowledgeStore.upsert
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
- **`OpenAICompatibleEmbedder`** — the alternative: any OpenAI-compatible
  `/embeddings` endpoint (OpenRouter, a gateway, a local TEI/vLLM/Ollama
  server). See "Embedding endpoint" below.

### Per-corpus embedder selection

`getEmbedderForCorpus(corpus, cfg)` (`embedding-config.ts`) picks the embedder
at upsert and query time so stored vectors and query vectors always match.
Under the default (Voyage) configuration:

| Corpus | Embedder | Use case |
|--------|----------|----------|
| `code`, `docs`, `spec` | `voyage-code-3` | Code-forward retrieval, structural understanding |
| `memory`, `task`, `pr`, `plan`, `artifact`, `session` | `voyage-4-large` | General semantic similarity |

Both models output **1024-dim** vectors — a single HNSW index serves all corpora;
namespace filtering (`{workspaceId}:{corpus}`) provides isolation. Every vector
read also filters `embedding_model` to the query embedder's model, so rows from
another model are found only by the lexical leg.

### Embedding endpoint (OpenAI-compatible)

Set `EMBEDDING_PROVIDER=openai_compat` to embed every corpus, for both writes
and queries, with one OpenAI-compatible endpoint instead of Voyage. Rerank
stays Voyage (and is skipped without `VOYAGE_API_KEY`). Contract:
`docs/specs/pluggable-knowledge-store.md` section 7a.

| Env | Meaning |
|-----|---------|
| `EMBEDDING_PROVIDER` | `voyage` (default, also when unset) or `openai_compat` |
| `EMBEDDING_BASE_URL` | e.g. `https://openrouter.ai/api/v1`; `/embeddings` is appended |
| `EMBEDDING_MODEL` | the model id, stored as `embedding_model` on each row |
| `EMBEDDING_API_KEY` | optional; sent as `Authorization: Bearer` |
| `EMBEDDING_QUERY_PREFIX` / `EMBEDDING_DOC_PREFIX` | prepended to queries / documents (Qwen3-Embedding wants an instruction on queries) |
| `EMBEDDING_MATRYOSHKA` | `true` lets a longer vector be truncated to 1024 and re-normalised; otherwise anything but 1024 is refused |
| `EMBEDDING_PRICE_PER_1M_TOKENS` | USD per 1M tokens for the usage estimate, or `unmetered` (a free local model) |
| `EMBEDDING_TIMEOUT_MS`, `EMBEDDING_MAX_BATCH` | optional; defaults 5 s per query / 30 s per document batch, 32 inputs per request |

A team or workspace can override this with a `secrets` row of purpose
`embedding_endpoint` (`POST /api/secrets`, owner/admin, team- or
workspace-wide), whose value is JSON: `{"baseUrl","model","apiKey"?,
"queryPrefix"?,"docPrefix"?,"matryoshka"?,"price"?}`, or `{"provider":"voyage"}`
to stay on Voyage. The workspace row wins over the team row.

The store column is a fixed `vector(1024)`. The request asks for
`dimensions: 1024`; a model that cannot return 1024 is refused with a logged
error and its chunks are stored lexical-only.

If the endpoint is down or slow, `embed` returns null and the write or query
goes lexical-only, as with a spend-guard denial; ingest and webhooks never fail
on it. Calls go through the spend guard and show up in `get_embedding_usage`
with `provider: openai_compat` (see `docs/specs/voyage-spend-guard.md` R-10).

**Switching models means purge and re-embed.** Vectors from two models are not
comparable. After a switch, old rows still match lexically but not by vector
until the namespace is re-ingested.

**Where the endpoint must be reachable.** The query embedding runs wherever the
query runs (Vercel, for the API and MCP), and must use the ingest model.
- **OpenRouter (recommended default):** works from Vercel with env only. One
  URL serves write and query.
- **Local model, runner-side ingest:** point the runner's env at the model over
  Tailscale. Queries on Vercel still need that same model, so also expose it
  with Tailscale Funnel or another tunnel and use that public URL as
  `EMBEDDING_BASE_URL` on Vercel. A model reachable only on the tailnet leaves
  Vercel queries lexical-only.

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

### Automated (event-driven)

There is **no scheduled ingest and no ingest workflow.**
`.github/workflows/knowledge-ingest.yml` was deleted in v0.175.0 (commit
`1b0ce506`) when full ingest moved to the runner-fleet claim protocol, and the
weekly Monday run died with it. Nothing has replaced the schedule: no
`cron-manifest.json` entry touches knowledge, and no code path produces
`trigger: 'scheduled'` (the schema annotates that value as PHASE 2, not
implemented).

Ingest is driven by events instead — a repo link, the first-index backfill, a
diff escalation on merge, or a manual POST to `/api/knowledge/ingest-jobs`.
A full job is claimed and executed by a runner, which ingests the buildd
workspace into the production knowledge store:

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

### Per-PR ingest jobs (KM v2)

Merged PRs on bound repos enqueue jobs into `knowledge_ingest_jobs`
(spec: `docs/design/workspace-knowledge-management.md` §3):

- **`diff` jobs** run serverless right after the webhook: changed files are
  re-ingested into `code`/`docs` via the GitHub contents API, and the patch
  itself is chunked per-file into the **`pr` corpus**
  (`source_id = pr:{prNumber}#{path}`, metadata `{prNumber, path, sha, taskId?,
  missionId?}`) so code deltas are retrievable history. PR chunks carry no
  `source_path` on purpose — path-keyed supersession must not hide older PRs.
- **`full` jobs** (first-index backfill, escalated large diffs, manual) need a
  checkout and run on the **runner fleet**: an idle runner offers its local
  clones to `POST /api/knowledge/ingest-jobs/claim`, reads the repo tree at the
  job sha via `git ls-tree`/`git show` (no working-tree mutation), and streams
  file batches to `POST /api/knowledge/ingest-jobs/{id}/files`; the server
  chunks/embeds/upserts. Completion (`…/{id}/complete`) prunes file-derived
  chunks in the workspace's `code`/`docs` namespaces that the run did not
  refresh (`sweep`), so deleted/renamed files drop out of retrieval. Disable
  per runner with `KNOWLEDGE_INGEST_JOBS=0`.

#### Job durability (leases + reclaim)

Every started job holds a **lease**: `lease_owner`, `lease_expires_at`,
`heartbeat_at`, plus an `attempts` counter
(`apps/web/src/lib/knowledge-ingest-lease.ts`). A runner claim leases for
`FULL_LEASE_MS` and renews on every `…/{id}/files` batch; the serverless diff
executor leases for `DIFF_LEASE_MS`. Terminal transitions release the lease.

A row still `running` past its lease had its executor die. Reclaim requeues it
(`attempts + 1`) and, past `MAX_INGEST_ATTEMPTS`, parks it in `error` — which the
idempotency predicate (`status != 'error'`) excludes, so a redelivery can enqueue
a fresh job. A lost `diff` job additionally escalates to a `full` job, which
recovers the file contents at that sha (the PR's own `pr`-corpus diff chunks are
not recoverable). Legacy rows with a NULL lease stay governed by `started_at`.

Reclaim runs inline on live paths — the runner claim poll, the manual enqueue
route, and the merged-PR webhook — deliberately **not** from a cron, since a
trigger that silently never fires is the failure mode this replaces.

`POST /api/knowledge/ingest-jobs` therefore answers **409 + `reason: 'stalled'`**
(not a 200 `already_queued`) when a job holds the per-workspace slot and nothing
is moving it.

**Caveat:** the completion sweep removes *all* file-derived chunks in
`{ws}:code` / `{ws}:docs` older than the run — including manual
`ingest-knowledge.ts` ingests from other source trees into the same namespaces.
Re-run those after a full sync, or keep them in the `spec` corpus (never swept).

### CI fallback for full jobs

Repos without a runner can execute full jobs from any CI that checks out the
repo — only a `BUILDD_API_KEY` secret is needed (no `DATABASE_URL` /
`VOYAGE_API_KEY`; embedding happens server-side):

```bash
BUILDD_API_KEY=bld_... bun run knowledge:ingest            # claims jobs for this checkout's origin repo
BUILDD_API_KEY=bld_... bun run knowledge:ingest --repo owner/name --dir /path/to/checkout
```

The script exits 0 when no jobs are queued, so it's safe on a schedule
(e.g. a small workflow step after merge).

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
- Set `VOYAGE_API_KEY` in the environment to enable embeddings + reranking, or
  `EMBEDDING_PROVIDER=openai_compat` (above) for embeddings from another endpoint.
- All ingestion is best-effort/idempotent; re-running is safe.
- Ingest uses the production `DATABASE_URL` and `VOYAGE_API_KEY` — no separate
  store or Neon branch. The runner-executed path reads them from its own
  environment; the HTTP path needs only `BUILDD_API_KEY`.
- `spec-sync.yml` is deprecated and was NOT superseded by a scheduled job — see
  "Automated (event-driven)" above. Nothing periodically refreshes the corpus, so
  a drift audit that assumes a fresh index is reading stale data until an ingest
  is triggered.
