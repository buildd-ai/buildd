---
title: Knowledge Ingest Pipeline
status: active
owner: max
last_verified: 2026-08-30
summary: Every file-derived chunk MUST arrive via a knowledge_ingest_jobs row that is atomically claimed by one executor, batched under the serverless body cap, and closed by an atomic completion.
domain: knowledge
surfaces: [apps/web/src/app/api/knowledge/ingest-jobs/claim/route.ts, packages/core/knowledge-store/full-ingest.ts, apps/web/src/lib/knowledge-ingest.ts, packages/core/db/schema.ts]
related: [knowledge-store-retrieval, webhook-dataflow, external-cron-triggers, codebase-memory-graph]
keywords: [knowledge_ingest_jobs, ingest-jobs/claim, sweep, skippedUnchanged, escalated, KNOWLEDGE_INGEST_JOBS, knowledge:ingest, file_hash]
verified_by: [apps/web/src/lib/knowledge-ingest.test.ts, apps/web/src/app/api/knowledge/ingest-jobs/claim/route.test.ts, apps/web/src/app/api/knowledge/ingest-jobs/[id]/files/route.test.ts, apps/web/src/app/api/knowledge/ingest-jobs/[id]/complete/route.test.ts, packages/core/__tests__/knowledge-full-ingest.test.ts, apps/runner/__tests__/unit/knowledge-ingest-poller.test.ts]
supersedes: []
---
# Knowledge Ingest Pipeline

**Capability statement**: Content MUST enter `knowledge_chunks` only via a
`knowledge_ingest_jobs` row, which MUST be claimed atomically by exactly one
executor, transmitted in batches that fit the serverless body cap, and closed by
an atomic `running → done|error` transition — so an ingest that silently never
happened is a row a reader can find, not an absence.

There are two job scopes and they use different executors. Confusing them is the
main way this pipeline goes quiet:

| Scope | Enqueued by | Executor | Transport |
|---|---|---|---|
| `diff` | merged-PR webhook (`enqueueMergedPrIngestJobs`) | the same Vercel request, via `after()` | GitHub contents API — no checkout |
| `full` | repo link, first-index backfill, diff escalation, manual `POST` | runner fleet poller, or any CI holding a checkout | `claim` → `/files` (→ `/graph`) → `/complete` |

`diff` jobs are never offered to the claim route (it filters
`scope = 'full'`), and no cron re-drives them. `full` jobs are never executed
in-request.

## Invariants

- **A job row is the only entry point for file-derived corpora.** `code` and
  `docs` chunks are written by `ingestFiles` under a job (`diff` in
  `executeDiffJob`, `full` in the `/files` route or the runner's local
  executor). There is no unauthenticated or job-less write path.
- **Claim is a single atomic `UPDATE … WHERE status='queued' RETURNING`.** Two
  executors offering the same repo cannot both get the same job; the loser gets
  zero rows back and falls through to the next candidate rather than erroring.
  `db.transaction()` is unavailable on neon-http, so optimistic locking is the
  only correct primitive here.
- **Completion is the same atomic pattern.** `/complete` updates
  `WHERE id = ? AND status = 'running'`; a second completion for the same job
  returns HTTP 409. `/files` and `/graph` likewise reject any job whose status
  is not `running` with HTTP 409, so a batch cannot land on a finished job.
- **At most one active `full` job per (workspace, repo).** Enforced at the DB
  layer by the partial unique index
  `knowledge_ingest_jobs_active_full_idx` on `(workspace_id, repo)`
  `WHERE scope='full' AND status IN ('queued','running')`, and pre-checked in
  `enqueueFullIngestJob`, `escalateToFullJob`, and the backfill branch so an
  overlapping enqueue is a `null` return rather than a conflict log line.
- **Re-enqueue is idempotent per `(workspace_id, sha, scope)`** via
  `knowledge_ingest_jobs_ws_sha_scope_idx`, partial on `status != 'error'`.
  Duplicate webhook deliveries insert nothing. A failed job does not block a
  retry because errored rows are excluded from the index. Full jobs enqueued
  without a sha are **not** covered by this index — Postgres treats NULLs as
  distinct — which is why the active-full index above exists.
- **Enqueue and claim reject `trigger`-level API keys** (HTTP 403). Both routes
  additionally scope non-admin callers to workspaces from
  `getIngestAccessibleWorkspaceIds` (explicit `canClaim` links plus
  `accessMode = 'open'` workspaces); a workspace outside that set yields 404 on
  enqueue and is skipped as a claim candidate.
- **`workspaceId` is always read from the job row, never from a request body.**
  The `/graph` route forces every entity, edge, and alias into the job's
  workspace, so a claimed job cannot be used to write into another workspace's
  namespace.
- **Batches MUST fit the serverless body cap.** The client plans batches at
  `MAX_BATCH_FILES = 40` / `MAX_BATCH_BYTES = 1_500_000`; the server rejects
  above `MAX_BATCH_FILE_COUNT = 64` files or `MAX_BATCH_TOTAL_BYTES = 4 MiB`
  with HTTP 413. The client caps are strictly below the server caps, so a
  correct client never provokes a 413. A single file over the byte budget still
  ships alone rather than being dropped.
- **The ingest filter runs on both sides.** `shouldIngestFile` /
  `classifyIngestCorpus` are applied by the client before sending and again by
  the server before chunking (defense in depth). Tests, lockfiles,
  `drizzle/`/`migrations/`/generated paths, dependency and build dirs, unknown
  extensions, and files over `MAX_INGEST_FILE_BYTES` (512 KiB) MUST NOT produce
  chunks.
- **Unchanged files are skipped but kept alive.** When a supplied `fileHash`
  matches a current chunk's `file_hash` for the same `(namespace, source_path)`,
  the file is counted in `skippedUnchanged` and its rows get `updated_at = NOW()`
  — because the completion sweep prunes by `updated_at`, and a skip without the
  touch would delete exactly the files that did not change.
- **A `full` run's prune is opt-in and mode-specific.** The HTTP path completes
  with `sweep: true` and the server deletes chunks in `{ws}:code` / `{ws}:docs`
  with a non-null `source_path` and `updated_at < job.startedAt`. The runner's
  local path completes with `sweep: false` because it already ran the more
  precise path-based `pruneOrphans`. Sweep MUST NOT run on an `error`
  completion, on a `diff` job, or when `startedAt` is null.
- **SCIP graph persistence is additive and never load-bearing.** `/graph` edges
  carry `scip:*` rules and layer on top of the `astgrep:*` edges written during
  file ingest; malformed sub-entries and edges with an endpoint outside the
  transmitted graph are skipped rather than failing the batch. A failing or
  absent enricher leaves the job `done` (`KNOWLEDGE_SCIP=1` gates it entirely).
- **Oversized diffs escalate rather than truncate.** Over `MAX_DIFF_FILES` (100)
  changed files, or over `MAX_DIFF_TOTAL_BYTES` (2 MiB) fetched, the `diff` job
  completes `done` with `stats.escalated = true` and enqueues a `full` job. A
  partial index is never presented as a complete one.
- **A workspace's first diff triggers a full backfill.** `executeDiffJob`
  captures `hadCodeIndex` *before* any upsert; when the `{ws}:code` namespace did
  not exist, it enqueues a `backfill`-trigger full job, because one PR's files
  are not an index.
- **`runDiffIngestJob` never throws.** Every failure is recorded on the job row
  as `status='error'` with the message, so a failed ingest is queryable rather
  than only present in logs.
- **The runner never abandons a claimed job.** If the claimed repo has no local
  checkout, the poller completes it as `error` instead of leaving it `running`.
  Concurrent polls are refused (`busy`) so one runner holds at most one job.
  `KNOWLEDGE_INGEST_JOBS=0` disables the poller per runner.
- **A full job's target sha degrades to HEAD, never to nothing.**
  `createGitRepoReader` resolves the job sha, fetches it once if the clone is
  behind, and falls back to `HEAD` — an index at HEAD beats no index. Reads use
  `git ls-tree`/`git show`, so a dirty or in-use clone is never mutated.
- **The CI entrypoint fails loudly on a missing credential.**
  `bun run knowledge:ingest` (`scripts/knowledge-ingest-ci.ts`) exits non-zero
  when `BUILDD_API_KEY` is unset, when the repo slug cannot be determined, and
  when a claimed job completes with `error`. It needs no `DATABASE_URL` /
  `VOYAGE_API_KEY` because embedding happens server-side. This is the opposite
  of the legacy direct-DB script (see Verification gaps).
- **Nothing schedules a periodic full ingest.** No `cron-manifest.json` job, no
  `vercel.json` cron, and no producer of `trigger: 'scheduled'` exists. Freshness
  is therefore a side effect of merged PRs: `computeFreshness` marks a workspace
  `stale` after `DEFAULT_STALE_AFTER_DAYS = 14` days without a `done` job, and
  nothing in the system acts on that verdict.

## Acceptance criteria

- AC-1: GIVEN two executors that both offer `owner/repo` WHEN both call
  `POST /api/knowledge/ingest-jobs/claim` for the same queued full job THEN
  exactly one response carries that job and the other either carries a different
  candidate or `{ job: null }`.
- AC-2: GIVEN a queued full job already exists for `(workspace, repo)` WHEN
  `POST /api/knowledge/ingest-jobs` is called for that pair THEN the response is
  `{ job: null, reason: 'already_queued' }` and no second row is inserted.
- AC-3: GIVEN a workspace with no linked `github_repos` row WHEN
  `POST /api/knowledge/ingest-jobs` is called THEN it returns HTTP 422 with
  `reason: 'no_github_repo'` and enqueues nothing.
- AC-4 (failure path): GIVEN a `trigger`-level API key WHEN it calls either
  `POST /api/knowledge/ingest-jobs` or `.../claim` THEN both return HTTP 403.
- AC-5 (failure path): GIVEN a job in status `done` WHEN a client posts to
  `.../{id}/files`, `.../{id}/graph`, or `.../{id}/complete` THEN each returns
  HTTP 409 naming the actual status, and no chunk, edge, or job-row write occurs.
- AC-6 (failure path): GIVEN an account without access to the job's workspace
  WHEN it posts to `.../{id}/files` THEN the response is HTTP 403 and no chunks
  are written.
- AC-7 (failure path): GIVEN a batch of 65 files WHEN posted to `.../{id}/files`
  THEN the response is HTTP 413 and no file in the batch is ingested.
- AC-8: GIVEN a file whose `fileHash` matches a current chunk for the same
  `(namespace, source_path)` WHEN the batch is posted THEN `skippedUnchanged`
  increments, no re-embed occurs, and the existing rows' `updated_at` is bumped
  so a later sweep does not prune them.
- AC-9: GIVEN a `full` job with a recorded `startedAt` WHEN it completes with
  `status: 'done'` and `sweep: true` THEN chunks in `{ws}:code` / `{ws}:docs`
  with a non-null `source_path` and `updated_at < startedAt` are deleted and the
  count is returned as `prunedChunks`.
- AC-10 (failure path): GIVEN the same job WHEN it completes with
  `status: 'error'` and `sweep: true` THEN zero chunks are deleted.
- AC-11: GIVEN a job whose `startedAt` is null WHEN it completes with
  `sweep: true` THEN zero chunks are deleted (an unknown claim time cannot bound
  a time-based prune).
- AC-12: GIVEN a merged PR touching more than `MAX_DIFF_FILES` files WHEN the
  diff job runs THEN it completes `done` with `stats.escalated = true` and a
  `full` job is enqueued for the same workspace and repo.
- AC-13: GIVEN a workspace whose `{ws}:code` namespace does not exist WHEN its
  first diff job completes THEN a `full` job with `trigger: 'backfill'` is
  enqueued.
- AC-14 (failure path): GIVEN the GitHub API rejects the changed-files listing
  WHEN the diff job runs THEN the job row ends `status='error'` with the message
  recorded, and `runDiffIngestJob` returns rather than throwing.
- AC-15: GIVEN a claimed job for a repo the runner has no checkout of WHEN the
  poller processes it THEN it calls `/complete` with `status: 'error'` and the
  job does not remain `running`.
- AC-16: GIVEN a graph payload whose entities name a different `workspaceId`
  than the job WHEN posted to `.../{id}/graph` THEN every entity, edge, and
  alias is written under the **job's** `workspaceId`.
- AC-17 (failure path): GIVEN a graph payload of more than
  `MAX_GRAPH_ELEMENTS` (200 000) total elements WHEN posted THEN the response is
  HTTP 413 and no entity is written.
- AC-18 (failure path): GIVEN `BUILDD_API_KEY` is unset WHEN
  `bun run knowledge:ingest` runs THEN it exits non-zero without claiming a job.
- AC-19: GIVEN `.github/workflows/` WHEN scanned for `name: Knowledge Ingest`
  THEN there is no match, and therefore the `workflow_run` trigger in
  `.github/workflows/knowledge-eval.yml` never fires. This assertion documents a
  live defect (see Verification gaps) — a fix must flip this AC, not delete it.

## Code surface

- Enqueue + list: `apps/web/src/app/api/knowledge/ingest-jobs/route.ts` — level
  gate (`:31`), `enqueueFullIngestJob` call (`:76`), `already_queued` (`:82`),
  `no_github_repo` 422 (`:68`); admin-only `GET` (`:108`).
- Claim: `apps/web/src/app/api/knowledge/ingest-jobs/claim/route.ts` —
  `MAX_OFFERED_REPOS` / `MAX_CANDIDATES` (`:18`), candidate query filtered to
  `status='queued' AND scope='full'` (`:46`), atomic claim + race fallthrough
  (`:57`).
- File batches: `apps/web/src/app/api/knowledge/ingest-jobs/[id]/files/route.ts`
  — server caps (`:23`), 409 status gate (`:86`), `deletions` (`:98`), hash-skip
  + `updated_at` touch (`:125`), per-corpus `ingestFiles` (`:153`).
- Graph: `apps/web/src/app/api/knowledge/ingest-jobs/[id]/graph/route.ts` —
  `MAX_GRAPH_ELEMENTS` (`:24`), workspace forced from the job (`:93`),
  skip-unresolvable edges (`:136`).
- Completion + sweep:
  `apps/web/src/app/api/knowledge/ingest-jobs/[id]/complete/route.ts` — atomic
  transition (`:69`), sweep predicate (`:85`).
- Server-side job logic: `apps/web/src/lib/knowledge-ingest.ts` —
  `enqueueFullIngestJob` (`:56`), `enqueueMergedPrIngestJobs` (`:116`),
  `runDiffIngestJob` (`:154`), `executeDiffJob` (`:195`), `escalateToFullJob`
  (`:402`), `MAX_DIFF_FILES` / `MAX_DIFF_TOTAL_BYTES` (`:26`).
- Access model: `apps/web/src/lib/knowledge-ingest-access.ts` —
  `getIngestAccessibleWorkspaceIds` (`:12`).
- Client executor: `packages/core/knowledge-store/full-ingest.ts` —
  `planFileBatches` (`:86`), `runFullIngestJob` (`:180`), `sweep: true` on the
  HTTP path (`:234`), `createGitRepoReader` (`:275`), `createHttpIngestApi`
  (`:308`).
- Runner poller: `apps/runner/src/knowledge-ingest.ts` —
  `KnowledgeIngestPoller` (`:46`), local-mode executor (`:127`), local-vs-HTTP
  mode selection and `KNOWLEDGE_INGEST_JOBS` (`:232`).
- CI entrypoint: `scripts/knowledge-ingest-ci.ts` — credential guard (`:41`),
  claim loop (`:68`); wired as `knowledge:ingest` in `package.json`.
- Shared chunk writer: `packages/core/knowledge-store/ingest.ts` —
  `ingestFiles` (`:158`), `touchBySource` of skipped paths (`:200`),
  `pruneOrphans` (`:220`).
- Shared filter: `packages/core/knowledge-store/ingest-filter.ts` —
  `shouldIngestFile` (`:67`), `MAX_INGEST_FILE_BYTES` (`:28`).
- Data model: `packages/core/db/schema.ts` — `knowledgeIngestJobs` (`:1674`),
  `knowledge_ingest_jobs_ws_sha_scope_idx` (`:1696`),
  `knowledge_ingest_jobs_active_full_idx` (`:1701`).
- Webhook trigger: `apps/web/src/app/api/github/webhook/route.ts` — enqueue +
  `after()` kick (`:602`).
- Observability: `packages/core/knowledge-store/health.ts` —
  `computeFreshness` (`:101`), `DEFAULT_STALE_AFTER_DAYS` (`:40`); surfaced by
  `apps/web/src/app/api/workspaces/[id]/knowledge-health/route.ts`.
- Legacy direct-DB script: `packages/core/scripts/ingest-knowledge.ts` —
  `DATABASE_URL` soft-skip (`:170`).

## Out of scope

- **Everything `knowledge-store-retrieval` owns**: chunk shape, `(namespace,
  source_id)` keying, `contentHash`, chunking strategy, embedder choice, RRF /
  BM25 / rerank query behaviour, `query_knowledge`, `spec_compare`, and memory
  mirroring. This spec stops at "the chunk was written under a job".
- The entity/edge graph's own semantics (entity kinds, rule vocabulary, alias
  resolution, `pending_entity_refs` healing). This spec covers only that
  `/graph` writes are additive, workspace-forced, and non-fatal.
- Retrieval-quality regression gating (`.github/workflows/knowledge-eval.yml`,
  `packages/core/eval/retrieval-baseline.json`) except for the dead
  `workflow_run` trigger recorded in AC-19.
- Consolidation, digests, and card generation over already-ingested chunks
  (`consolidation.ts`, `cards.ts`) — downstream of ingest.
- The `memory`, `task`, `plan`, `session`, and `artifact` corpora, which do not
  flow through `knowledge_ingest_jobs`.

## Verification gaps

Unguarded claims and known defects. Nothing below is asserted as holding.

1. **The `Retrieval Eval` post-ingest trigger is dead.**
   `.github/workflows/knowledge-eval.yml:18` triggers on
   `workflow_run: workflows: ["Knowledge Ingest"]`, but
   `.github/workflows/knowledge-ingest.yml` was **deleted** in `Release v0.175.0`
   (commit `1b0ce506`, 2026-08-22) when full jobs moved to the runner fleet. No
   workflow in `.github/workflows/` is named `Knowledge Ingest`, so that trigger
   can never fire; the eval now runs only on `workflow_dispatch` and on PRs
   touching the retrieval paths. Post-ingest retrieval regressions are unmeasured.
   Same class of failure as the five cron routes parked on Vercel-native crons
   (see `external-cron-triggers`): a declared trigger with no producer.
2. **`docs/knowledge-store.md` describes a workflow that no longer exists.**
   Lines 12, 83–96 and 211 present `knowledge-ingest.yml` as running on every
   push to `dev` and weekly on Mondays at 06:17 UTC; line 213 says
   "`spec-sync.yml` is deprecated; the weekly knowledge-ingest job supersedes
   it." **There is no weekly knowledge-ingest job.** The schedule died with the
   workflow, `cron-manifest.json` has no knowledge entry, `vercel.json` declares
   no crons, and no code path produces `trigger: 'scheduled'` — the value is
   accepted by the enqueue route and never emitted. Full ingest is therefore
   event-driven only (repo link, first-index backfill, diff escalation, manual
   `POST`). Nothing in CI catches this drift.
3. **A claimed job has no lease and no expiry.** Nothing bounds how long a job
   may sit in `running`. Because `knowledge_ingest_jobs_active_full_idx` covers
   `status IN ('queued','running')`, one runner that dies mid-job blocks *every*
   future full job for that `(workspace, repo)` pair indefinitely, and
   `enqueueFullIngestJob` reports `already_queued` forever.
   `/api/cron/lease-expiry-guard` covers `credential_leases` only; no cron
   touches `knowledge_ingest_jobs`. No test asserts any recovery.
4. **A lost `diff` job is never retried.** The webhook comments that jobs
   "remain queued for a later executor"
   (`apps/web/src/app/api/github/webhook/route.ts:620`), but no such executor
   exists: the claim route serves `scope='full'` only, and no cron drains queued
   diff jobs. Worse, the queued row occupies
   `knowledge_ingest_jobs_ws_sha_scope_idx`, so a redelivery of the same webhook
   inserts nothing — the PR's files are silently never ingested. Unguarded.
5. **The legacy direct-DB script soft-skips a broken credential and exits 0.**
   `packages/core/scripts/ingest-knowledge.ts:170-181` prints a warning and
   `process.exit(0)` when `DATABASE_URL` is unset *or* unparseable. That is how a
   malformed repo `DATABASE_URL` secret produced green ingest runs that ingested
   nothing. The modern path is safer by construction — `knowledge:ingest` needs
   no `DATABASE_URL` and hard-fails on a missing `BUILDD_API_KEY` — but the
   script is still present and callable, and the runner's mode selection
   (`apps/runner/src/knowledge-ingest.ts:232`) picks local mode on the mere
   *presence* of `DATABASE_URL` + `VOYAGE_API_KEY` without validating either, so
   a malformed value there turns every local-mode job into an `error`
   completion. No test covers either behaviour.
6. **Per-job writes are not bound to the job's claimer.** The invariant is that
   a file push, a graph push, or a completion for a job MUST come from the
   executor that claimed it, and any other caller MUST be rejected. Nothing can
   enforce that: the job row carries no claimer or executor identity to check a
   caller against. No test asserts it. Specifics are tracked privately until the
   guard lands.
7. **Claim has a head-of-line window.** The candidate query takes the 50 oldest
   queued full jobs globally (`MAX_CANDIDATES`) and filters by offered repo *in
   application code*. A backlog of 50+ queued full jobs for repos a caller does
   not hold starves that caller indefinitely, with no error emitted — the same
   shape as the task-claim starvation fixed in v0.157.0. Offered repos beyond
   `MAX_OFFERED_REPOS` (200) are silently truncated. No test covers either.
8. **The two full-ingest modes cover different corpora.** The HTTP path
   (`/files`) classifies into `code`/`docs` only; the runner's local path also
   writes the `spec` corpus and prunes it against the *docs* seen-set
   (`apps/runner/src/knowledge-ingest.ts:195`). A workspace whose full jobs run
   over HTTP therefore never refreshes `{ws}:spec`, which `spec_compare` reads.
   No test asserts parity between the modes.
9. **`deletions` on `/files` has no in-repo producer.** The route accepts and
   tests a `deletions` array, but `createHttpIngestApi.pushFiles` sends only
   `{ files }`; the HTTP path relies on the completion sweep instead. Live but
   unexercised surface.
10. **The completion sweep's documented collateral damage is unguarded.** It
    deletes *every* file-derived chunk in `{ws}:code` / `{ws}:docs` older than
    the run — including chunks ingested from a different source tree into the
    same namespace. Documented in `docs/knowledge-store.md`; no test or
    server-side guard distinguishes them.
11. **Freshness is observed, never acted on.** `computeFreshness` returns
    `stale` after 14 days without a `done` job, and the verdict is rendered by
    the knowledge-health route. Nothing enqueues a job in response, so a repo
    with no merges simply decays. `packages/core/__tests__/knowledge-health.test.ts`
    pins the verdict function, not any remediation.
