---
title: Local Runner Provider
status: draft
owner: max
last_verified: 2026-11-14
summary: A team MUST be able to serve embeddings and chat from one of its own runners' Ollama through a runner-polled relay with no secret, no mixed vector spaces and never a paid fallback.
domain: runners
surfaces: [apps/web/src/app/api/workers/heartbeat/route.ts, packages/core/knowledge-store/embedding-config.ts, apps/web/src/lib/chat/models.ts, apps/runner/src/local-model-endpoint.ts]
related: [pluggable-knowledge-store, runner-heartbeat, settings-models, knowledge-ingest-pipeline, voyage-spend-guard, provider-failover]
keywords: [local_runner, ollama, relay, relay queue, model_relay_jobs, local_runner_unavailable, embedding dimensions, vector(768), vector(1536), per-namespace dimension, knowledge_namespaces, re-embed, lexical-only, local models, 11434, tunnel, funnel]
verified_by: []
supersedes: []
---
# Local Runner Provider

**Capability statement**: A team MUST be able to choose `local_runner` as the
provider that embeds its knowledge and answers its chat, served by the Ollama
on one of the team's own runners through a server-side relay queue that the
runner claims by outbound poll, so that no credential is stored, the server
never opens a connection to the runner's model, vectors of different models or
sizes never share a search, and a missing runner degrades (embeddings to
lexical-only, chat to a typed refusal) instead of spending on a paid provider.

## Status and authority

This spec is `draft`: nothing in it is built. Every backticked symbol that
resolves names code that exists today and is cited as the thing this design
extends; names that do not resolve are proposals the task breakdown in
section 10 fixes (SPEC-FORMAT rule 7 makes those warnings on a draft). It
becomes `active` when the Phase 1-3 guards in section 9 exist and are named
in `verified_by`.

Where this spec and `pluggable-knowledge-store` disagree, this spec wins on
two points only: E-6 ("the column is a fixed `vector(1024)`") is amended by
section 5, and E-2's provider list gains `local_runner`. Everything else in
that spec (one provider per namespace for write and query, E-5 model
isolation, E-8 never-throw, the Voyage default) stays binding here.

Design input, not normative: the owner's mission brief for "Local runner
provider: run embeddings and chat on a runner's own Ollama". Measurements in
this document are none; where a number is a default it is marked as such and
is tunable.

---

## 1. Problem, outcomes, non-goals

**Problems**

- P1. Embeddings became a use of a team's connected provider (PR #6087:
  `teams.embedding_provider` / `teams.embedding_model`, `GET|PATCH
  /api/providers/embedding`, `EMBEDDING_PROVIDERS` in
  `packages/core/providers/embedding.ts`), but every choice is a paid, hosted
  endpoint reachable from Vercel. A team with a capable machine pays per token
  for something that machine does for free.
- P2. The runner already knows how to use a local model for its agents
  (`resolveLocalModelEndpoint`, `applyLocalModelEnv` in
  `apps/runner/src/local-model-endpoint.ts`; loopback only, never reported to
  the server). Nothing lets the *service* use that model: the query-time
  embedding and chat run on Vercel, which cannot reach a machine behind NAT.
  The existing workaround (tunnel the model and configure it as a LiteLLM
  gateway, section 8.2) exposes the model to the internet.
- P3. The vector column is one fixed `vector(1024)` with one global HNSW index
  (`knowledgeChunks.embedding` in `packages/core/db/schema.ts`,
  `knowledge_chunks_embedding_hnsw_idx` in the baseline migration). Open
  embedding models come in 384, 768, 1024, 1536 and larger; E-6 refuses or
  truncates anything that is not 1024, so most Ollama embedding models cannot
  be used at all.
- P4. There is no path from "a runner has Ollama" to "the team can see and
  pick it": the heartbeat payload (`apps/runner/src/buildd.ts`, `sendHeartbeat`)
  carries no local-model facts and `worker_heartbeats` has no column for them.

**Outcomes**

- O1. A team picks `local_runner` (plus a runner and a model) for embeddings,
  for chat, or both, on Settings › Providers, with no key entered.
- O2. The relay is the only path: the server enqueues, the runner claims by
  outbound HTTPS, computes against its loopback Ollama, posts the result back.
  The server never connects to the model.
- O3. Vectors are comparable only within one (model, dimension) space, by
  construction of the storage, not by convention.
- O4. No runner online means a visible, typed degradation and zero spend
  elsewhere.
- O5. The runner reports what it serves and how it is doing (models, sizes,
  throughput, last error) so the picker and the runner page tell the truth.

**Non-goals**

- NG1. Agent runs. An agent's model traffic already goes straight to the
  runner's own Ollama via `BUILDD_LOCAL_MODEL_URL`; the relay does not carry
  agent turns and `local_runner` is not an agent backend
  (`surfaces['agent-claude']`, `surfaces['agent-codex']` refuse with
  "set BUILDD_LOCAL_MODEL_URL on the runner instead").
- NG2. Decision calls (`packages/core/decision-client.ts`,
  `teams.decision_model`). They need calibrated confidence; `local_runner` is
  not a decision model in this spec. The chat route's directive decider keeps
  its current provider when chat is on `local_runner`.
- NG3. The brokered agent capability `model.inference`
  (`model-inference-agent-capability`): not routed to the relay here. When it
  is, its cost MUST be 0, not `maxUsdPerCall`.
- NG4. Streaming of chat tokens in the first release (section 4.5 allows
  progress deltas; finishing the stream contract is Phase 4).
- NG5. Reranking. The reranker stays Voyage and is skipped when absent, as
  today.
- NG6. More than one runner serving one team's pick at once (no load
  balancing); a pick names one runner (section 2.3).
- NG7. Any schema, runtime or UI change in the PR that merges this spec.

---

## 2. The `local_runner` provider

### 2.1 Registry

**Invariants**

- R-1. `local_runner` is a provider id in `PROVIDER_IDS` and an entry in
  `PROVIDER_REGISTRY` (`packages/ai-kit/src/models/provider-registry.ts`,
  re-exported by `packages/core/providers/registry.ts`) with `shapes: []`:
  it has **no credential shape**, so no `secrets` purpose, no `secrets` row,
  and no new credential table (CLAUDE.md "Credentials" rule honoured by
  having nothing to store).
- R-2. Surface support: `chat` ok (via `relay`); `agent-claude`,
  `agent-codex` and `cloud-egress` refused with a reason that points at
  `BUILDD_LOCAL_MODEL_URL` (NG1). Embeddings are not a registry surface today
  (`SURFACES` has four entries, none for embeddings); `local_runner` is added to
  `EMBEDDING_PROVIDERS` and `EmbeddingProviderId` instead, exactly as
  `openrouter` / `openai` / `litellm` were.
- R-3. `local_runner` is never a tier provider (`TIER_PROVIDER_IDS`) and never a
  failover target (`provider-failover` `dispatchable:false` rule applies).

### 2.2 Configuration storage (existing provider config, no new credential table)

Embeddings reuse the two columns PR #6087 added:

- `teams.embedding_provider = 'local_runner'`,
  `teams.embedding_model = '<ollama model tag>'` (e.g. an id like
  `nomic-embed-text` or `mxbai-embed-large`; `embeddingChoiceError` validates it
  like any other provider's model).

Chat reuses the per-surface assignment that already exists:

- `teams.provider_assignments.chat = 'local_runner'` (`ProviderAssignments`
  in `packages/core/providers/assignments.ts`; `assignmentError` accepts the
  new id). Unlike other assignments, which only reorder the resolver's
  candidates, `local_runner` for chat is **exclusive**: section 4.6.

One new jsonb column carries what neither of those can:

- `teams.local_runner` (proposed; type `LocalRunnerConfig`):
  `{ runnerId: string | null, chatModel: string | null }`.
  - `runnerId` is a `worker_heartbeats.id` (the id `/api/runners/[heartbeatId]`
    already uses as the runner's identity; there is no `runners` table). It
    MUST belong to an account of the same team (`accounts.teamId`), checked on
    write and again on every enqueue. `null` is refused on write: a pick
    without a runner is not a pick (NG6).
  - `chatModel` is the Ollama tag chat relays to; required when
    `provider_assignments.chat = 'local_runner'`.
  - Dimensions are **not** stored here. They come from the runner's advert
    (section 6) at the time of the pick and are recorded per namespace
    (section 5), so a model that changes size shows up as a mismatch, not a
    silent overwrite.

Routes (NOT IMPLEMENTED; proposed): GET /api/providers/local-runner returns
`{ runnerId, chatModel, embedModel, runner: { online, models[] } | null }`;
PATCH /api/providers/local-runner writes the column and, in the same request,
the embedding pick (so the three places change atomically for the reader: one
UPDATE on `teams`). Permission: `POLICY_PERMISSION` (`manage_team_settings`),
the same as `/api/providers/embedding`; task tokens are read-only as there.

**Acceptance criteria**

- AC-1: GIVEN a team with no runner WHEN PATCH /api/providers/local-runner is
  sent with `runnerId: null` THEN it returns HTTP 400 naming `runnerId` and the
  team row is unchanged.
- AC-2: GIVEN a `runnerId` whose account belongs to another team WHEN PATCH is
  sent THEN it returns HTTP 403 and nothing is written.
- AC-3: GIVEN a valid pick WHEN written THEN `GET /api/providers/embedding`
  returns `{ provider: 'local_runner', model: <tag> }` and no row with any
  purpose is added to `secrets`.
- AC-4: GIVEN `local_runner` WHEN `POST /api/providers` is asked to store a
  credential for it THEN it returns HTTP 422 with `provider_scope_unsupported`
  or `provider_surface_unsupported` (the registry has no shape to write).

### 2.3 Which runner serves which team

- The pinned runner is the only server. Auth for the relay is the runner's
  existing `bld_` key (`Authorization: Bearer`, resolved by
  `authenticateApiKey` → `accounts.teamId`). A claim is scoped
  `team_id = account.teamId AND runner_id = <the heartbeat row of this account>`;
  a runner never sees another team's jobs, and a team's other runners never
  see jobs pinned to the chosen one.
- The runner learns its own id from the heartbeat response: `/api/workers/heartbeat`
  gains a `heartbeatId` field (the upserted `worker_heartbeats.id`) and a
  `relay` block (section 6.3). The runner echoes `heartbeatId` as `runnerId` on
  every relay call and the server verifies the row belongs to the calling
  account; a mismatch is HTTP 403.
- Picking a runner on a `localUiUrl` that later changes makes a new heartbeat
  row and orphans the pick; the picker shows the pinned runner as "gone" and
  the no-runner path (section 7) applies until the owner re-picks. The FK is
  `ON DELETE SET NULL`.

---

## 3. Relay queue: storage

One table, `model_relay_jobs` (proposed; Drizzle `modelRelayJobs`), modelled on
`knowledgeIngestJobs` (lease columns) and `workflowCommandOutbox`
(`attempt_count`, `not_before`, `lease_until`, terminal `dead`), both in
`packages/core/db/schema.ts`.

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid pk | job id, returned to the waiter |
| `team_id` | uuid not null, FK teams cascade | scope of every claim |
| `workspace_id` | uuid null | for attribution and the sensitive-workspace check |
| `runner_id` | uuid not null, FK worker_heartbeats set null | the pinned runner at enqueue time |
| `kind` | text | `embed` \| `chat` |
| `surface` | text | `ingest` \| `query` \| `reembed` \| `chat` — who asked, for metrics |
| `namespace` | text null | `embed` only: the `knowledge_chunks.namespace` the vectors are for |
| `model` | text not null | Ollama tag the runner MUST use; it never substitutes |
| `status` | text | `queued` \| `leased` \| `done` \| `failed` \| `expired` \| `cancelled` |
| `payload` | jsonb not null | section 3.1; bounded |
| `result` | jsonb null | section 3.2 |
| `error` | jsonb null | `{ code, message }`, codes in section 3.3 |
| `attempts` | int default 0 | incremented on every lease |
| `max_attempts` | int not null | 2 for `embed`, 1 for `chat` (defaults) |
| `lease_owner` | text null | `runnerId:leaseId`, diagnostics only |
| `lease_expires_at` | timestamptz null | liveness; renewed by progress posts |
| `not_before` | timestamptz not null | retry backoff |
| `deadline_at` | timestamptz not null | the waiter's deadline; after it the job is `expired` |
| `created_at`, `leased_at`, `finished_at` | timestamptz | |

Indexes: `(team_id, runner_id, status, not_before)` for the claim scan; a
partial `(deadline_at) WHERE status IN ('queued','leased')` for the expiry
sweep; `(finished_at)` for retention.

### 3.1 Payload

- `embed`: `{ inputs: string[], inputType: 'query' | 'document', dimensions: number }`.
  At most `EMBEDDING_MAX_BATCH`-sized batches as `planEmbedRequests` already
  produces for `openai_compat` (default 32 inputs, about 16k estimated tokens).
  `dimensions` is the namespace's recorded size (section 5); the runner MUST
  refuse a result of another size (`dimension_mismatch`) rather than pad or cut.
- `chat`: `{ messages, options }` in the shape the chat model layer already
  hands a provider (the AI SDK language model's doGenerate input: messages,
  temperature, maxOutputTokens, stop, tools absent in v1). Size cap 1 MB; a
  larger payload is refused at enqueue with `payload_too_large` and the chat
  turn returns `message_too_long` as it does today.

Payload rows are team-internal Postgres data, like `knowledge_chunks` content;
the X-3 "no sensitive export" rule of `pluggable-knowledge-store` is not
crossed because the consumer is the team's own runner, which already holds the
workspace checkout. Retention (section 3.5) keeps the exposure window short.

### 3.2 Result

- `embed`: `{ vectors: number[][], dimensions, model, promptTokens, durationMs }`.
  The server validates every vector has `dimensions` floats before storing
  anything; one bad vector fails the whole job (`bad_result`).
- `chat`: `{ text, finishReason, usage: { promptTokens, completionTokens }, durationMs, evalRate }`
  with an optional partialText written by progress posts (section 4.5).

### 3.3 Error codes (stored in `error.code` and surfaced to callers)

`runner_offline` (no claim before deadline), `lease_lost` (runner died
mid-job, attempts exhausted), `model_missing` (runner's Ollama has no such
tag), `dimension_mismatch`, `bad_result`, `ollama_error` (upstream 4xx/5xx,
message is Ollama's), `timeout` (runner-side call exceeded its budget),
`payload_too_large`, `cancelled`.

### 3.4 Usage ledger

`model_relay_usage_daily` (proposed), keyed
`(day, team_id, runner_id, kind, model)` with `jobs`, `errors`, `prompt_tokens`,
`completion_tokens`, `duration_ms`, mirroring `voyageUsageDaily`
(`voyage_usage_daily`): bounded by its keys, no content. Written on every
terminal transition. This is what the UI's throughput and error figures read
(section 6.4), and what `embedding-usage.ts`-style admin views can join.

### 3.5 Retention and expiry

- A sweep runs on every claim (as `reclaimStaleIngestJobs` does for ingest
  jobs: the poll is the trigger on purpose) and additionally from the existing
  `/api/cron/maintenance` so an idle team's rows do not linger: `queued` or
  `leased` past `deadline_at` → `expired` with `runner_offline` or `lease_lost`;
  `leased` past `lease_expires_at` with attempts left → `queued`,
  `not_before = now + 2^attempts * 5s`; terminal rows older than 24 h deleted.
- A waiter that gives up (section 4.3) marks its job `cancelled`; a runner
  that posts a result for a `cancelled` or `expired` job gets HTTP 410 and
  drops it.

**Acceptance criteria**

- AC-5: GIVEN a `leased` job whose `lease_expires_at` passed with
  `attempts < max_attempts` WHEN the next claim or sweep runs THEN it is
  `queued` again with `not_before` in the future and `attempts` unchanged until
  the next lease.
- AC-6: GIVEN a `leased` job whose lease lapsed with `attempts = max_attempts`
  WHEN the sweep runs THEN it is `failed` with `error.code = 'lease_lost'` and
  the ledger's `errors` for that day increments by one.
- AC-7: GIVEN a `queued` job past `deadline_at` WHEN the sweep runs THEN it is
  `expired` with `runner_offline` and is never returned by a later claim.
- AC-8: GIVEN a terminal job finished more than 24 h ago WHEN the sweep runs
  THEN the row is gone.

---

## 4. Relay queue: protocol

All three routes are NOT IMPLEMENTED (proposed). They authenticate exactly as
`/api/knowledge/ingest-jobs/claim` does (`authenticateApiKey`, `trigger` level
refused with 403) and additionally verify `runnerId` (section 2.3).

### 4.1 Claim: POST /api/relay/jobs/claim

Body `{ runnerId, models: string[], max?: number }`. `models` is what the
runner's Ollama currently serves (section 6.1); the server only hands out jobs
whose `model` is in that list, so a tag that was removed on the machine fails
at enqueue time (`model_missing`) instead of after a claim.

The claim is one atomic statement, no `db.transaction` (CLAUDE.md, neon-http):

```sql
UPDATE model_relay_jobs
SET status = 'leased', lease_owner = $owner, leased_at = now(),
    lease_expires_at = now() + $lease, attempts = attempts + 1
WHERE id IN (
  SELECT id FROM model_relay_jobs
  WHERE team_id = $team AND runner_id = $runner
    AND status = 'queued' AND not_before <= now() AND deadline_at > now()
    AND model = ANY($models)
  ORDER BY CASE kind WHEN 'chat' THEN 0 ELSE 1 END, created_at
  LIMIT $max
  FOR UPDATE SKIP LOCKED
)
RETURNING id, kind, model, payload, deadline_at, lease_expires_at;
```

`claimDue` in `apps/web/src/lib/workflow/command-outbox.ts` is the shape to
copy. Chat jobs sort first because a person is waiting on them. Default lease
60 s (tunable), renewed by progress posts. `max` defaults to 1 for chat
runners and 4 for embed-only batches; the runner serialises Ollama calls
itself (one at a time per model: Ollama loads one model at a time on most
machines, and two concurrent embed batches halve each other's throughput).

Response `{ jobs: [...], pollAfterMs }`. An empty claim is HTTP 200 with
`jobs: []`; the server sets pollAfterMs (default 15 000 when the runner is a
pinned relay host, 0 = stop polling when the pick was removed).

### 4.2 Result: POST /api/relay/jobs/[id]/result

Body `{ runnerId, leaseId, ok: true, result } | { runnerId, leaseId, ok: false, error: { code, message } }`.
The update is `UPDATE … SET status = 'done'|'failed', result|error, finished_at
WHERE id = $id AND status = 'leased' AND lease_owner = $owner RETURNING id`;
zero rows → HTTP 409 (the lease moved) or 410 (terminal). A failed result
with a retryable code (`ollama_error` 5xx, `timeout`) and attempts left goes
back to `queued` with backoff; `model_missing`, `dimension_mismatch`,
`bad_result` and 4xx are final.

### 4.3 Waiting for a result (server side)

`awaitRelayJob(jobId, deadline)` (proposed helper): poll the row every 500 ms
until it is terminal or `deadline_at` passes, then mark `cancelled` if still
open and return `{ ok: false, code: 'runner_offline' | <error.code> }`. It
MUST never throw into ingest, a webhook or the chat stream (E-8).

Fast-fail before enqueue: the enqueuer checks the pinned runner is online —
`runnerOnlineNow(lastHeartbeatAt, presenceConnected, now)` from
`packages/shared/src/runner-liveness.ts`, the same predicate the runner list
uses — and that its last advert lists `model`. Otherwise no row is written and
the caller gets `runner_offline` or `model_missing` in under 50 ms of DB time.
A runner that is online but not claiming is caught by `deadline_at` instead.

Deadlines (defaults, tunable in one place): query embed 20 s (the local
machine may need to load the model; `openai_compat`'s 5 s is too short for a
cold Ollama), document batch 180 s, re-embed batch 300 s, chat 300 s.

### 4.4 Nudging the runner

The runner already subscribes to Pusher for task dispatch; a `relay.job.queued`
event on its private channel makes it claim at once, with the poll from
section 4.1 as the fallback (`RUNNER_HEARTBEAT_INTERVAL_MS` is 60 min and is
not the relay poll; the relay has its own interval, section 6.3). A runner MUST
work correctly with Pusher absent: claims then wait at most pollAfterMs.

### 4.5 Progress: POST /api/relay/jobs/[id]/progress

Body `{ runnerId, leaseId, partialText?: string }`. Renews the lease
(`lease_expires_at = now() + lease`) and, for chat, appends to
`result.partialText`. The waiter forwards new text to the chat stream as it
appears, so a person sees tokens arrive even though the provider contract is
non-streaming. Optional for the runner in v1; required by Phase 4 (NG4).

**Acceptance criteria**

- AC-9: GIVEN two runners of one team claiming at once for the same pinned
  job WHEN both statements run THEN exactly one receives the job and the
  other's claim returns `jobs: []`; the loser never receives a job pinned to
  the other runner.
- AC-10: GIVEN a runner whose key belongs to team A WHEN it claims with a
  `runnerId` of team B THEN HTTP 403 and no row changes.
- AC-11: GIVEN a job leased by owner X WHEN owner Y posts a result THEN HTTP
  409 and the row is unchanged.
- AC-12: GIVEN a result whose `vectors[i].length ≠ payload.dimensions` WHEN
  posted THEN the job is `failed` with `dimension_mismatch`, nothing is written
  to `knowledge_chunks`, and the waiter receives `ok: false`.
- AC-13: GIVEN the pinned runner is not online by `runnerOnlineNow` WHEN an
  embed or chat is requested THEN no `model_relay_jobs` row is inserted and the
  caller gets `runner_offline` before any poll.

---

## 5. Variable vector length: per-namespace dimension

### 5.1 As-is (inspected 2026-11-14)

- `knowledgeChunks.embedding` is `vector(1024)` (`vectorType('embedding',
  { dimensions: 1024 })`, `packages/core/db/schema.ts`), with one global HNSW
  cosine index `knowledge_chunks_embedding_hnsw_idx` created in
  `packages/core/drizzle/20261006230118_baseline/migration.sql`.
- Per-row `knowledge_chunks.embedding_model` exists and every vector leg
  already filters on it (`_vectorSearch` and the near-dupe / seed paths in
  `packages/core/knowledge-store/pg-vector-store.ts`: `AND embedding_model = …`).
  Model isolation is therefore already enforced *within* 1024.
- `Embedder` (`packages/core/knowledge-store/types.ts`) carries `model` and
  `dimensions`; the store trusts `dimensions` to be 1024.
- The size of a namespace's vectors is nowhere recorded; it is a property of
  the column type.

### 5.2 Options considered

| | A. One column per supported size | B. Untyped `vector` column + expression partial indexes | C. Table per size |
|---|---|---|---|
| Migration risk to the Voyage path | none: `embedding` stays `vector(1024)` with its index; new nullable columns are metadata-only adds | `ALTER COLUMN TYPE vector` on the largest table; the HNSW index MUST be dropped and rebuilt; a rewrite is likely | copy of every row |
| Index | one plain HNSW per column; HNSW ignores NULLs so no partial predicate needed | one HNSW per size on `(embedding::vector(N))` `WHERE vector_dims(embedding) = N`; the query text must match the expression exactly or the planner scans | one per table |
| Drizzle fidelity | native (`vectorType` per column, `.using('hnsw', …)`) | expression + partial index in the snapshot; fragile under `db:generate` | duplicated model |
| Mixing guard | `CHECK (num_nonnulls(embedding, embedding_768, embedding_1536) <= 1)` + model filter | model filter only; a size mix inside one column is legal to Postgres | by construction |
| Adding a size | one migration: column + index | one migration: index | one migration: table + wiring |
| Row cost | a few NULL bytes per unused column | none | none |

**Decision: A.** The Voyage default stays byte-for-byte untouched (no `ALTER
TYPE`, no index rebuild on the live column), the storage itself refuses a mix,
and Drizzle expresses it without hand SQL. Supported sizes at launch: **768,
1024, 1536** (columns `embedding_768`, `embedding` (1024, unchanged name so
no Voyage code churn), `embedding_1536`). 384 (all-MiniLM) and 4096 are
deliberately not supported until a team asks; a model of an unsupported size is
refused at pick time (section 6.2), never truncated. Matryoshka truncation is
NOT offered for `local_runner` in v1: a local model is free, so re-embedding
at its native size costs nothing but time, and truncation needs a per-model
fact the runner cannot verify.

The CHECK constraint is added `NOT VALID` and validated in a follow-up
statement so the migration takes no long lock on the table (`schema-change`
skill applies; the migration is its own approved task).

### 5.3 Per-namespace record

New table `knowledge_namespaces` (proposed; Drizzle `knowledgeNamespaces`):

| Column | Meaning |
|---|---|
| `namespace` text pk | same string as `knowledge_chunks.namespace` |
| `team_id` uuid | owner |
| `corpus` text | |
| `embedding_provider` text, `embedding_model` text, `dimensions` int | the space the namespace's vectors are currently stored in |
| `vector_column` text | `embedding` \| `embedding_768` \| `embedding_1536`, derived from `dimensions`, stored for the query builder |
| `reembed_status` text | `none` \| `pending` \| `running` \| `done` \| `failed` |
| `reembed_total` int, `reembed_done` int, `reembed_started_at`, `reembed_finished_at` | progress the UI shows |
| `updated_at` | |

**Invariants**

- D-1. A namespace has exactly one embedding space at a time. The first vector
  write to a namespace creates its row from the embedder that wrote it; every
  later write MUST match `(embedding_model, dimensions)` or go through D-3.
- D-2. Every vector read of a namespace selects the column named by
  `vector_column` and keeps the E-5 filter `embedding_model = <query model>`.
  A query embedder of another size than the namespace's is not run against the
  index at all: the vector leg is skipped and the query is lexical-only
  (there is no vector of that size to compare with).
- D-3. Model or size change: when the team's pick (`resolveEmbeddingConfig`
  output, with `dimensions` from the runner advert) differs from the
  namespace row, the namespace is marked `reembed_status = pending`, its
  row's `(embedding_model, dimensions, vector_column)` are set to the new
  space, and a re-embed walks the namespace in batches: each batch writes the
  new vector into the new column and NULLs the others. Until a row is
  re-embedded it is reachable only through the lexical leg (E-5 + D-2). Rows
  are never migrated by copy or cast (L-7).
- D-4. Vectors of two models or two sizes never share a `knowledge_chunks` row
  (the CHECK) nor a candidate set (the model filter + the column choice).
- D-5. Namespaces without a row (everything written before this ships) are
  treated as `(voyage default model for the corpus, 1024, embedding)` on first
  touch and get a row written then; no backfill migration over
  `knowledge_chunks` is needed.
- D-6. Re-embed is a job stream, not a request: for `local_runner` it enqueues
  `embed` relay jobs with `surface = 'reembed'` at low priority (after live
  queries, by the claim ORDER BY); for a hosted provider it runs through the
  existing ingest batch path. It is resumable (`reembed_done` is the cursor:
  rows ordered by `id` with `embedding_model <> new model`) and bounded per
  tick so it never starves live work.

**Acceptance criteria**

- AC-14: GIVEN a namespace stored at 1024 WHEN a 768-dimension embedder writes
  to it without a re-embed being started THEN the write is refused with
  `dimension_mismatch`, no row changes, and the error is logged once per
  namespace.
- AC-15: GIVEN a row with a vector in `embedding_768` WHEN an UPDATE tries to
  also set `embedding` THEN Postgres rejects it on the CHECK constraint.
- AC-16: GIVEN a namespace at (model M1, 1024) and a team pick changed to
  (M2, 768) WHEN the next ingest or query touches the namespace THEN
  `reembed_status` is `pending` within that request and, until a row is
  re-embedded, that row is returned by lexical search only.
- AC-17: GIVEN a re-embed that completed WHEN counted THEN every row of the
  namespace has `embedding_model = M2`, a non-null `embedding_768`, and NULL
  in `embedding` and `embedding_1536`.
- AC-18: GIVEN a Voyage-default team with no row in `knowledge_namespaces` WHEN
  it queries THEN the SQL issued is identical to today's (`embedding` column,
  `embedding_model` filter) and a row is created with `dimensions = 1024`.

---

## 6. Runner: detection, advertising, serving, reporting

### 6.1 Ollama detection and model listing

- The runner probes Ollama at `BUILDD_LOCAL_MODEL_URL` when set, else the
  default `http://127.0.0.1:11434`; loopback only, enforced by the same check
  `resolveLocalModelEndpoint` applies today. Ollama's GET api/tags lists models;
  Ollama's POST api/show per model yields `capabilities` (`embedding`, `completion`)
  and `model_info.<arch>.embedding_length` (the dimension). Probe on start,
  then at most every 5 min (default) and on every relay `model_missing`.
- Opt out with `BUILDD_LOCAL_MODEL_RELAY=0`: the runner still uses the model
  for its agents but advertises nothing and claims nothing. Default on when
  Ollama answers; a machine with no Ollama costs one refused connection per
  probe interval and advertises nothing.
- `buildd doctor` (`apps/runner/src/doctor.ts`) gains a "Local models" line:
  reachable or not, server version, model count, and whether this runner is
  the pinned relay host.

### 6.2 Advertising in the heartbeat

`POST /api/workers/heartbeat` payload gains:

```json
"localModels": {
  "server": { "kind": "ollama", "version": "0.x.y", "reachable": true, "checkedAt": "…" },
  "models": [ { "name": "<tag>", "family": "…", "parameterSize": "…",
                "capabilities": ["embedding"], "dimensions": 768, "contextLength": 8192 } ]
}
```

Bounded: at most 50 models, `name` ≤ 128 chars, unknown fields dropped by a
strict parser (`parseLocalModelsAdvert`, proposed, in `packages/shared`), as
`parseLocalSessionEvent` does for local sessions. Stored in
`worker_heartbeats.local_models` jsonb (proposed) and `local_models_at`.
Never a URL, never a token: the advert says what is served, not where
(the server has no inbound path, and MUST not gain one through this field).

The picker (section 7.3) offers only tags whose `capabilities` include
`embedding` for the Embeddings row, and `completion` for chat; an embedding
model whose `dimensions` is not in {768, 1024, 1536} is listed disabled with
"size N not supported".

### 6.3 Serving

The heartbeat response's `relay` block is `{ host: boolean, pollAfterMs }`.
When `host` is true the runner starts a `RelayPoller` (proposed, next to
`ModelProbePoller` and `KnowledgeIngestPoller` in `apps/runner/src/workers.ts`),
which:

- claims on a Pusher nudge and every pollAfterMs (default 15 s), regardless
  of worker slots: relay jobs do not take a worker slot and run while agents
  run, because a chat answer cannot wait for a 40-minute task. They DO stop
  while a person holds the runner (`claimsHeldByPerson`), the same "nothing
  new starts" rule the other pollers obey;
- runs `embed` via Ollama's POST api/embed (`{ model, input: string[] }`) and
  `chat` via Ollama's POST api/chat with `stream: true`, forwarding deltas as
  progress posts every 500 ms and the full text as the result;
- enforces per-job budgets from `deadline_at` minus a safety margin, aborts the
  Ollama call at the budget and posts `timeout`;
- never substitutes a model, never pads or truncates a vector
  (`dimension_mismatch` if api/embed returns another length);
- serialises Ollama calls per model and lets a `chat` job pre-empt the next
  `embed` batch (claim order already does this server side).

### 6.4 Throughput and error reporting

- Every result carries `durationMs`, token counts and, for chat, Ollama's
  `eval_count / eval_duration` as evalRate; the server folds them into
  `model_relay_usage_daily` (section 3.4).
- The runner keeps a rolling last-hour window in memory (`jobs`, `errors`,
  `p50/p95 durationMs`, last error) and includes it as
  `localModels.relayStats` in the next heartbeat; the runner page and the
  provider card read it from `worker_heartbeats.local_models`.
- The runner's own log line per job is one line, no payload content (the
  heartbeat redaction rules apply unchanged).

**Acceptance criteria**

- AC-19: GIVEN Ollama answering api/tags with two models WHEN the runner
  heartbeats THEN `localModels.models` has both with their `capabilities` and
  `dimensions`, and contains no URL field.
- AC-20: GIVEN `BUILDD_LOCAL_MODEL_RELAY=0` WHEN the runner heartbeats THEN
  localModels is absent and the runner never calls the claim route.
- AC-21: GIVEN a heartbeat response with `relay.host = false` WHEN the poller
  ticks THEN it does not claim; GIVEN `host = true` THEN it claims within
  pollAfterMs.
- AC-22: GIVEN a person holds the runner (`claimsHeldByPerson`) WHEN a relay
  job is queued THEN the runner does not claim it until the hold ends, and the
  server reports `runner_offline` to the waiter only if the deadline passes.
- AC-23: GIVEN Ollama's api/embed returning 1024 floats for a job with
  `dimensions: 768` WHEN the runner handles the result THEN it posts
  `ok: false, code: 'dimension_mismatch'` and nothing else.

---

## 7. No runner online: degradation, never a paid fallback

### 7.1 Embeddings

- `resolveEmbeddingConfig` (`packages/core/knowledge-store/embedding-config.ts`)
  returns, for a `local_runner` pick, a config with `provider: 'local_runner'`
  and the pinned runner, model and the namespace's dimensions; when the pinned
  runner is not online or does not advertise the model it returns the same
  shape with `unavailable` set to a reason string, exactly as a missing key
  does today for a hosted pick.
- `getEmbedderForCorpus` returns a `LocalRunnerEmbedder` (proposed; implements
  `Embedder` by enqueuing an `embed` job and awaiting it) or, when
  `unavailable` is set, `null` → lexical-only for that namespace, with the one
  warning per reason the function already logs.
- On a relay failure at run time (`runner_offline`, `timeout`, …) `embed`
  returns `null` (E-8): the write stores lexical-only rows **without** a file
  hash so the next ingest retries them, and the query runs lexical-only. It
  never throws and never calls Voyage, OpenRouter, OpenAI or a gateway.

### 7.2 Chat

- `resolveChatModel` (`apps/web/src/lib/chat/models.ts`) sees
  `provider_assignments.chat = 'local_runner'` and returns a
  `localRunnerLanguageModel` (proposed; an AI SDK `LanguageModel` whose
  doGenerate/doStream enqueue a `chat` job) for `teams.local_runner.chatModel`.
  The tier the router chose is recorded but does not change the model: a local
  pick has one model.
- When the pinned runner is not online, or the relay fails, the turn returns
  `unavailable('local_runner_unavailable', 503, { runnerId, reason })`:
  `ChatUnavailableReason` (`packages/shared/src/chat.ts`, mirrored in
  `packages/ai-kit/src/chat/contract/index.ts`) gains `local_runner_unavailable`
  with the copy "Your local runner is offline or is not serving this model.
  Start the runner, or pick another provider in Settings › Providers." The
  response names the runner so the UI can link to it.
- **No fallback.** The retry at `FALLBACK_TIER` in `apps/web/src/lib/chat/turn.ts`
  and `withChatPool` challenger selection are both skipped when the assigned
  provider is `local_runner`. `resolveInferenceRoute` is never called for the
  turn. The same holds for the embedder: a `local_runner` pick never reaches
  `voyageConfig` or an `OpenAICompatibleEmbedder`. This is the one hard rule of
  the spec: a team that chose free must never be billed by a path it did not
  choose.

### 7.3 UI behaviour (contract, not layout)

- Settings › Providers shows a "Local runner" card (registry `settingsCard`)
  whenever the team has at least one runner that has ever advertised
  localModels; otherwise a one-line hint on how to get one ("install the
  runner on a machine with Ollama") with no card.
- The card lists the team's runners with their online state (the same
  `runnerOnlineNow` predicate as the runners page), the models each
  advertises, the pick (runner + chat model), and the last hour's relay
  figures (jobs, errors, p95) from the advert.
- The Embeddings row (`UsedForSection`, Settings › Providers › Used for)
  offers `local_runner` only when a runner advertises at least one
  `embedding`-capable model; its model field is a select of those tags with
  the dimension shown, unsupported sizes disabled (section 6.2). Changing the
  model or size shows the re-embed consequence before saving ("N rows in M
  namespaces will be re-embedded; until then they are found by text only") and
  the per-namespace progress after.
- A chat turn refused with `local_runner_unavailable` renders the copy above
  with a link to the runner; it never offers "use a team key instead" inline,
  because that would be the paid fallback by another door (an admin changes
  the pick in Settings).
- The runner detail page shows the "Local models" advert and relay stats, and
  marks the pinned relay host.

**Acceptance criteria**

- AC-24: GIVEN a `local_runner` embedding pick and the pinned runner offline
  WHEN a namespace ingests THEN rows are written with `embedding` NULL and
  `file_hash` NULL, no request leaves the server to any embedding vendor, and
  the warning names the runner.
- AC-25: GIVEN the same state WHEN a knowledge query runs THEN results come
  from the lexical leg only and the response's pipeline field says so.
- AC-26: GIVEN `provider_assignments.chat = 'local_runner'` and the pinned
  runner offline WHEN `POST /api/chat/[id]` is called THEN HTTP 503 with
  `error: 'local_runner_unavailable'` and `runnerId`, and no provider key is
  resolved (`resolveInferenceRoute` not called).
- AC-27: GIVEN the runner online and a `chat` job that fails with
  `ollama_error` WHEN the turn finishes THEN the same 503 is returned with
  `reason` carrying Ollama's message, and the ledger's `errors` increments.
- AC-28: GIVEN the pick is removed (`provider: null`) WHEN the runner next
  heartbeats THEN `relay.host` is false and its poller stops; GIVEN a team key
  exists for another provider THEN chat uses it only because the assignment
  now points there, never because the local one failed.

---

## 8. Docs plan

Written in the `buildd-docs` repo (product docs) in the same mission; this
spec is the contract they describe.

### 8.1 Pages

1. **Local models on your runner** — what the relay is (outbound only, no
   secret, no port opened), installing Ollama beside the runner, which tags
   appear in Settings, picking a runner, what "offline" does to search and
   chat, and the opt-out env.
2. **Choosing an embedding model** — supported sizes (768/1024/1536), why a
   size or model change re-embeds, how long that takes on a typical machine
   (measured once Phase 3 exists; no figures before), and the lexical-only
   window.
3. **Runner page: Local models and relay** — reading throughput, p95, errors,
   and `buildd doctor`'s line.
4. **Alternative: tunnel Ollama as a gateway** (section 8.2).
5. `docs/knowledge-store.md` in this repo gains a paragraph pointing at this
   spec, next to the embedding-provider paragraph PR #6087 added.

### 8.2 Tunnel-to-custom-endpoint alternative

For a team that wants query-time embeddings from Vercel without the relay's
queue hop, the already-shipped path stays documented:

- Expose Ollama's OpenAI-compatible root (`/v1`) with Tailscale Funnel,
  cloudflared or any HTTPS tunnel, and connect it as the team's **LiteLLM
  gateway** provider (`litellm`, which accepts any OpenAI-compatible base URL
  plus a key — Ollama ignores the key; use a tunnel-side access token where the
  tunnel supports one). Then pick `litellm` for embeddings with the Ollama tag
  as the model.
- Honest trade-offs the page MUST state: the model is reachable from the
  internet (the tunnel's auth is the only gate); Vercel-to-tunnel latency on
  every query; the 1024-dimension limit of E-6 applies to `openai_compat`
  until section 5 ships for every provider (Phase 2 makes the per-namespace
  dimension provider-agnostic, at which point the tunnel path gains the same
  sizes); chat through `custom-endpoint` is refused by the registry
  (`R.endpointChat`), so chat on a tunnel also needs `litellm`.
- When to prefer which: relay for anything behind NAT or where the model must
  stay private; tunnel when the machine is already exposed or lower query
  latency matters more than exposure.

---

## 9. Test and contract matrix

| ID | Contract | Case | Phase | Gate |
|---|---|---|---|---|
| M1 | Registry | `local_runner` has `shapes: []`, chat ok, agents refused; `POST /api/providers` 422 (AC-4) | 1 | unit |
| M2 | Pick validation | AC-1, AC-2, AC-3; runner of other team refused | 1 | route test |
| M3 | Claim atomicity | AC-9 against real Postgres (two concurrent claims) | 2 | `apps/web/tests/db/` |
| M4 | Scope | AC-10, AC-11 | 2 | route test |
| M5 | Lease and expiry | AC-5, AC-6, AC-7, AC-8 | 2 | unit + db |
| M6 | Fast fail | AC-13: no row inserted when runner offline | 2 | unit |
| M7 | Dimension columns | AC-14, AC-15, AC-17, AC-18 against real Postgres; Voyage SQL unchanged (golden) | 3 | db test |
| M8 | Re-embed | AC-16; resumable cursor; rows reachable lexically meanwhile | 3 | unit + db |
| M9 | Runner advert | AC-19, AC-20; strict parser drops unknown fields and URLs | 2 | runner unit |
| M10 | Runner poller | AC-21, AC-22, AC-23 with a fake Ollama (`Bun.serve` on loopback, as `local-model-cli.test.ts` does) | 2 | runner unit |
| M11 | Embeddings degrade | AC-24, AC-25; assert zero outbound calls to Voyage/OpenRouter/OpenAI (mock fetch, fail on any) | 3 | unit |
| M12 | Chat refusal, no fallback | AC-26, AC-27, AC-28; `resolveInferenceRoute` spy never called | 3 | route test |
| M13 | Ledger | every terminal transition writes one `model_relay_usage_daily` increment; no content columns | 2 | unit |
| M14 | Specs lint | symbols named here resolve once built; `bun run specs:check` green; spec promoted to `active` with M1-M13 in `verified_by` | 4 | CI |

---

## 10. Task breakdown (later tasks implement; each needs owner approval)

Order matters only where "Depends on" says so; T1 is the only schema change
and goes through the `schema-change` skill.

| # | Task | Scope | Depends on |
|---|---|---|---|
| T1 | Schema: relay and dimensions | `model_relay_jobs`, `model_relay_usage_daily`, `knowledge_namespaces`, `knowledge_chunks.embedding_768` / `embedding_1536` + HNSW indexes + `NOT VALID` CHECK then VALIDATE, `teams.local_runner`, `worker_heartbeats.local_models` / `local_models_at`. One migration folder, `bun db:generate`, commute check against dev. | none |
| T2 | Provider registry and config routes | `local_runner` in `PROVIDER_IDS`, `PROVIDER_REGISTRY` (`shapes: []`), `EMBEDDING_PROVIDERS`, `assignmentError`; `LocalRunnerConfig`; GET/PATCH /api/providers/local-runner with AC-1..AC-4; `embeddingChoiceError` accepts the id. | T1 |
| T3 | Runner: Ollama detection and advert | probe, `parseLocalModelsAdvert` (shared), heartbeat payload + server storage, `heartbeatId` and `relay` in the heartbeat response, doctor line, `BUILDD_LOCAL_MODEL_RELAY`. | T1 |
| T4 | Relay server | store module (`enqueue`, `claimDue`-style claim, `complete`, `progress`, `sweep`), the three routes, `awaitRelayJob`, fast-fail on `runnerOnlineNow`, Pusher nudge, ledger writes, maintenance-cron hook. | T1, T3 (for `runnerId` verification) |
| T5 | Runner: relay poller | `RelayPoller`, Ollama embed and chat clients, progress posts, budgets, per-model serialisation, hold gate, rolling stats in the advert. | T3, T4 |
| T6 | Knowledge: per-namespace dimension | `knowledgeNamespaces` access, column choice in every vector leg of `pg-vector-store.ts` (D-2), CHECK-aware upsert, D-5 lazy row, re-embed job stream (D-3, D-6) for hosted providers and the relay, progress fields. Voyage golden SQL unchanged (AC-18). | T1 |
| T7 | Embeddings on the relay | `LocalRunnerEmbedder`, `resolveEmbeddingConfig` branch with `unavailable`, lexical-only degrade (AC-24, AC-25), no-vendor-call guard test. | T4, T6 |
| T8 | Chat on the relay | `localRunnerLanguageModel`, exclusive assignment in `resolveChatModel`, `local_runner_unavailable` reason + copy in shared and ai-kit contracts, skip `FALLBACK_TIER` and pool for `local_runner`, partial-text forwarding. | T4 |
| T9 | Settings and runner page UI | Local runner card, Embeddings row model select from adverts with disabled unsupported sizes, re-embed consequence and progress, chat refusal rendering with runner link, runner page advert + relay stats. Phone and desktop screenshots via the visual-review recipe. | T2, T3, T6 |
| T10 | Docs | the four buildd-docs pages of section 8 plus the `docs/knowledge-store.md` paragraph; the tunnel alternative with its trade-offs. | T5, T8 (so figures are real) |
| T11 | Promote spec | M1-M13 in `verified_by`, `status: active`, E-6 in `pluggable-knowledge-store` rewritten to point here, `last_verified` bumped. | all |

---

## 11. Human-review questions (one batch)

- Q1. Column-per-size (A) over untyped column (B): confirm. The cost is three
  nullable vector columns on `knowledge_chunks` and one migration per new
  size; the gain is no `ALTER TYPE` on the live column and a CHECK that
  refuses a mix.
- Q2. Supported sizes 768/1024/1536 only, no Matryoshka for `local_runner`,
  384 deferred: confirm or add 384 now.
- Q3. One pinned runner per team (NG6) rather than "any online runner of the
  team that advertises the model": confirm. Pinning keeps the namespace's
  model and size stable and makes "which machine did this" a fact; the cost
  is no failover between two home machines.
- Q4. `teams.local_runner` jsonb column for `{ runnerId, chatModel }`
  (alongside the existing `embedding_provider` / `embedding_model` and
  `provider_assignments.chat`): confirm, or prefer two plain columns.
- Q5. Chat is `503 local_runner_unavailable`, never a fallback to a team key
  even when one exists (section 7.2): confirm this is the intended hard rule
  (an admin changes the pick; the chat UI never offers a paid fallback inline).
- Q6. Relay jobs run while agents run (no worker slot) but stop while a
  person holds the runner: confirm.
- Q7. Payload retention 24 h for terminal rows and the chat payload cap of
  1 MB: confirm.
- Q8. Phase 2 (T6) makes the per-namespace dimension provider-agnostic, which
  lifts E-6's 1024 limit for `openai_compat` too: in scope for this mission,
  or `local_runner` only?

---

**Code surface** (today's, that this spec extends): `apps/web/src/app/api/workers/heartbeat/route.ts`,
`apps/web/src/app/api/providers/embedding/route.ts`,
`packages/core/providers/embedding.ts`, `packages/core/providers/assignments.ts`,
`packages/core/knowledge-store/embedding-config.ts`,
`packages/core/knowledge-store/pg-vector-store.ts`,
`packages/core/knowledge-store/types.ts`, `apps/web/src/lib/chat/models.ts`,
`apps/web/src/lib/chat/turn.ts`, `apps/runner/src/local-model-endpoint.ts`,
`apps/runner/src/workers.ts`, `apps/runner/src/buildd.ts`,
`apps/web/src/lib/workflow/command-outbox.ts` (claim pattern),
`apps/web/src/app/api/knowledge/ingest-jobs/claim/route.ts` (lease and
reclaim pattern), `packages/shared/src/runner-liveness.ts`,
`packages/core/db/schema.ts` (`knowledgeChunks`, `workerHeartbeats`, `teams`,
`voyageUsageDaily`).

**Out of scope**: agent runs on a local model (already `BUILDD_LOCAL_MODEL_URL`);
decision calls and the brokered `model.inference` capability; reranking; load
balancing across runners; billing or plan entitlements for local models (they
are unmetered and attributed as such); the pluggable index backend
(`pluggable-knowledge-store` Phases 1-4).
