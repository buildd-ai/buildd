---
title: BYO Evidence Storage
status: draft
owner: max
last_verified: 2026-09-30
summary: Buildd MUST write each task's run evidence to a team-configured S3-compatible bucket, keep only pointers in Postgres, and index the error-bearing parts into a searchable `evidence` corpus read through the reach guard.
domain: knowledge
surfaces: [apps/runner/src/session-diagnostics.ts, apps/web/src/app/api/workers/[id]/session-upload-url/route.ts, apps/web/src/lib/storage-keys.ts, apps/web/src/lib/chat/registry.ts]
related: [knowledge-store-retrieval, knowledge-ingest-pipeline, artifacts-and-sharing, credential-isolation]
keywords: [evidence, s3, r2, byo, transcript, ci-log, query_knowledge, read_evidence, evidence_backends, evidence_objects, evidence_storage_credential]
---

# BYO Evidence Storage

**Capability statement**: Buildd MUST be able to write each task's full run
evidence (session transcript, failing command output, CI job logs, test
reports) to a bucket the team configures (S3, R2, or any S3-compatible API),
MUST hold only a compact record plus object pointers in Postgres, and MUST
index the error-bearing segments into a `{workspaceId}:evidence` knowledge
corpus, so that "why did task X fail" is answerable from chat, MCP or an agent
without opening GitHub or a terminal.

This spec is `draft`: nothing below "Current state" is built. Naming a planned
symbol or route in backticks is the correct state for a draft (SPEC-FORMAT rule
7/8); each becomes a lint error when the spec is promoted to `active`.

## Why

A CI-fix chain used up all its attempts and the last one reported success off a
single-file type check. The real failure (a ratchet baseline mismatch and a
runner test timeout) only ever existed in the raw GitHub job log. There were no
error traces (capture is pattern-only), the task's message history was empty,
and the fix task's summary claimed a push while its recorded diff was zero
files. Chat could not answer, and neither could an MCP client, because
anonymous GitHub API calls were rate-limited.

## Current state (verified against the code)

- **Transcripts are uploaded, but nothing reads them.** `uploadSessionDiagnostics`
  (`apps/runner/src/session-diagnostics.ts`) ships `transcript.jsonl` and
  `session.log` through `POST /api/workers/[id]/session-upload-url` (body
  `{kind, sizeBytes}`) to the buildd-managed bucket, at key
  `sessions/{team}/{workspace}/{worker}/{filename}`. No route, tool or UI
  consumes those keys.
- **Upload happens once, at session end, and only for `done` or `error`**
  (`apps/runner/src/workers.ts`, the "Durable session diagnostics" block). A
  runner that dies mid-session uploads nothing.
- **The "last 200" cap is in the runner's in-memory ring buffers, not in the
  uploader.** `worker.toolCalls` and `worker.messages` each evict with `shift()`
  past 200 entries and `worker.output` past 100 (`apps/runner/src/workers.ts`).
  `buildSessionTranscript` can only serialise what survived. Fixing the cap
  therefore means flushing segments before eviction, not changing the upload.
- **Tool-result bodies are never retained.** The transcript holds milestones,
  text and tool_use messages, tool-call inputs and `output` lines. A
  `tool_result` is scanned for error patterns (`scanToolResult`) and dropped.
- **Two byte ceilings, both 8 MiB:** `MAX_TRANSCRIPT_BYTES` on the runner
  (writes a `truncated` marker) and `MAX_SESSION_ARTIFACT_BYTES` on the server
  (413, and bound into the presigned `ContentLength`).
- **Keys are write-once.** The route answers 409 if `objectExists(storageKey)`,
  so one object per worker per kind. Segmented uploads need a different key
  layout and route.
- **Only `workspaces.dataClass = 'sensitive'` is excluded (403).** There is no
  `private` class on workspaces and no `tasks.visibility` column;
  `docs/design/private-task-execution.md` is a design, not built.
- **Storage is one env-configured bucket.** `apps/web/src/lib/storage.ts` builds
  a single `S3Client`; there is no per-team client.
- **`result.evidence` does not exist yet.** `TaskResult` in
  `packages/shared/src/types.ts` has no `evidence` field (task 0c635dfe
  introduces the compact record). This spec stores the bulk that record links to.
- docs/design/workspace-knowledge-management.md §8 already decides "Postgres
  for the index, R2 for blobs". This spec follows it: **the bucket holds blobs
  and the searchable index stays in Postgres.**

## Invariants

1. **Bucket holds blobs, Postgres holds pointers.** No evidence body is stored
   in a Postgres column other than the chunks of the `evidence` corpus.
2. **The runner never holds bucket credentials.** It uploads only to a
   presigned PUT the server minted for one exact key, valid 15 minutes, with the
   byte length bound into the signature.
3. **Credentials live only in `secrets`.** Purpose `evidence_storage_credential`
   is never serialised into a claim response, agent env, chat tool result or
   log line.
4. **Nothing unredacted leaves the runner or the server** (see Redaction).
5. **A storage failure never fails a task.** Upload, probe, indexing and
   retention errors are recorded on the pointer row and surfaced in health;
   none of them changes `tasks.status` or `workers.status`.
6. **Every read is proxied through the server**, passes the reach guard, and is
   audited. Chat and MCP never receive a presigned GET.
7. **Private and sensitive evidence is never embedded.** It is stored in the
   team's own bucket and never sent to the embedder or the shared namespace.
8. **Object keys are assembled only in `apps/web/src/lib/storage-keys.ts`**,
   which `storage-keys.guard.test.ts` enforces for every other module.

## Backend configuration

Table `evidence_backends` holds configuration only (not credentials, so this
is not a per-integration credential table in the sense of CLAUDE.md):

- `id`, `team_id`, `workspace_id` (nullable = team default);
- `provider` (`s3` | `r2` | `s3_compatible` | `buildd_default`), `endpoint`,
  `region`, `bucket`, `prefix`, `force_path_style`;
- `credential_secret_id` → a `secrets` row, purpose
  **`evidence_storage_credential`**, `encryptedValue` = JSON blob
  `{accessKeyId, secretAccessKey, sessionToken?}`;
- `sse` (`none` | `AES256` | `aws:kms` with key id);
- `retention_days`, `max_bytes_per_task`;
- `status` (`unverified` | `ok` | `failing`), `last_verified_at`, `last_error`.

Adding the purpose is two edits and no DB enum migration: the `SecretPurpose`
union in `packages/core/secrets/types.ts` and the `secrets.purpose` `$type` in
`packages/core/db/schema.ts` (docs/credentials-architecture.md, "Adding a new
backend"). Delivery rule mirrors `cloudflare_token` ("never sent to a runner"),
**not** `mcp_credential`, which the claim route does deliver to the agent.

**Precedence, most specific wins:** workspace backend → team backend →
`buildd_default`. The `secrets` scoping order is workspace → account → team,
but evidence resolution runs server-side with no claiming account, so the
account tier does not apply; the backend row pins its secret by
`credential_secret_id`, and that secret's `team_id` MUST equal the backend's.

**Verification** runs on save and daily: PUT, GET, DELETE of
`{prefix}/.buildd-probe/{uuid}`. It needs Put and Get, optionally Delete, and
never List. The result sets `status` and reuses the `secrets` health columns
(`healthStatus`, `lastVerifiedAt`, `lastVerificationError`) the way
`POST /api/secrets/[id]/verify` does for the Cloudflare token. A `failing`
backend raises a health alert.

Surfaces: Settings → Storage (admin), MCP `manage_evidence_backends` (admin
token), and chat read-only status.

## What gets written

| kind | writer | trigger | notes |
|---|---|---|---|
| `command_output` | runner | a `tool_result` with `is_error === true` whose source tool is Bash | Full stdout/stderr, redacted. Hooks the existing tool-result branch in `apps/runner/src/workers.ts` that already calls `scanToolResult`. |
| `test_report` | runner | `.test-report.log` or equivalent exists at session end | Raw, as-is, redacted. |
| `ci_job_log` | server | CI-failure webhook for a buildd-owned PR | Fetched with the GitHub App token via `githubApiText` (`apps/web/src/lib/ci-failure-inspect.ts`), ANSI escape sequences stripped. Attached to the retry task and the root lineage. |
| `transcript` | runner | segment flush + session end | P2. Segmented JSONL, flushed before ring-buffer eviction, plus tool_result bodies. Manifest records `complete: bool`. |
| `pr_diff` | server | PR opened/updated | P3, optional. |

**Key layout** (built by a new `buildEvidenceObjectKey` in `storage-keys.ts`,
every segment through `assertSafeKeySegment`):
`{prefix}/{workspaceId}/{rootTaskId}/{taskId}/{workerId}/{kind}/{ts}-{seq}.{jsonl|log}.gz`,
plus `manifest.json` per worker holding each object's kind, bytes, sha256,
redaction version and `complete`. The legacy `sessions/...` layout stays as is
for `buildd_default` until P2 replaces it.

**Upload route:** `POST /api/workers/[id]/evidence-upload-url {kind, seq, sizeBytes}`
generalises `session-upload-url`: same worker/account/team authorization,
same "key derived server-side, body key ignored" rule, but resolves the
backend, enforces `max_bytes_per_task` across the task's `evidence_objects`,
and signs against that backend's client (a per-backend client factory replaces
the single env-configured client in `storage.ts`).

## Redaction

- **Runner-side channels, today:** `createSecretRedactor` is built in
  `startSession` (`apps/runner/src/workers.ts`) from exactly three sources:
  `BUILDD_API_KEY`, `worker.mcpSecrets`, and `worker.roleEnvSecrets`. It does
  exact-value matching (including JSON-escaped forms) plus the generic
  credential patterns on free text. Evidence MUST use the same list, and a test
  MUST fail when a new claim-delivered secret channel exists that is not in it.
- **Raw log bodies MUST go through `createSecretRedactor(...)` on the whole
  text.** `redactSecretsInBody` only runs generic patterns on the
  `SECRET_SCAN_FIELDS` allowlist, which is right for structured transcript
  records and wrong for a raw log.
- **Server-side (CI logs):** `createSecretRedactor` with the installation token
  and any repo secret values the server holds as the exact-value list, plus the
  generic patterns. GitHub's own `***` masking is kept.
- **Not redacted: tenant data-class patterns** (UUIDs, handles, repo names).
  The no-prod-data gate protects this public repo, not a tenant's evidence in
  the tenant's own bucket; scrubbing identifiers would destroy the diagnostic
  value.
- The manifest records `redactionVersion`. A bump marks older objects for
  optional re-scan.

## Postgres pointers

Table `evidence_objects`:
`id`, `workspace_id`, `task_id`, `root_task_id`, `worker_id`, `pr_number`,
`kind`, `backend_id`, `object_key`, `bytes`, `sha256`, `created_at`,
`expires_at`, `upload_state` (`pending` | `stored` | `failed` | `unreadable`),
`index_state` (`skipped` | `queued` | `indexed` | `failed`).

`result.evidence.links[]` (task 0c635dfe) references `evidence_objects.id`,
never raw URLs.

## The `evidence` corpus

- Namespace `{workspaceId}:evidence`. Add `'evidence'` to the `Corpus` union
  (`packages/core/knowledge-store/types.ts`), `ALL_CORPORA`
  (`packages/core/knowledge-store/health.ts`) and `CORPORA`
  (`packages/core/mcp-tools.ts`) so `query_knowledge` and `recall` accept it.
- **Ingest path is not `knowledge_ingest_jobs`.** That table is repo-file
  shaped: `repo` is NOT NULL, `scope` is `diff | full`, `trigger` is a
  git-event enum, and its idempotency index is `(workspace_id, sha, scope)`. The
  ingest-pipeline spec scopes its job-only invariant to file-derived chunks.
  Evidence is not file-derived, so it follows the `task`/`pr`/`artifact`/
  `session` corpora: a direct best-effort `knowledgeStore.upsert` (the
  `mirrorWorkProduct` pattern in `packages/core/mcp-tools.ts`). Durability comes
  from `evidence_objects.index_state`: a sweep re-drives rows stuck in `queued`
  or `failed`, so an index that silently never happened is a row a reader can
  find.
- **Only signal is indexed, never whole transcripts:** error blocks and stack
  traces; failing test names with assertion messages; non-zero command tails;
  CI step failure digests (`extractFailureDigest` already exists in
  `apps/web/src/lib/ci-failure-digest.ts`); the final agent summary. A
  log-aware chunker splits on test and file boundaries and caps chunks per
  object (default 40).
- Chunk metadata: `taskId`, `rootTaskId`, `prNumber`, `kind`, `errorClass`,
  `testName?`, `file?`; `source_id = evidence_objects.id#chunk`. Existing
  embedder, lexical-only fallback when none is configured.
- Recurring failures surface through `query_knowledge corpus=evidence`, and link
  into `get_failure_analytics` signatures (P3).
- On expiry or deletion, chunks are removed by `source_id` prefix.

**Private and sensitive rules:**

- A **sensitive workspace** (`dataClass = 'sensitive'`, the only privacy class
  in code today) MAY write objects to a BYO backend only; it MUST NOT write to
  `buildd_default` (today's 403 stands for teams without a BYO backend) and its
  `index_state` is always `skipped`, because indexing sends text to the
  embedder. `query_knowledge` already withholds `memory`/`initiative` for
  sensitive contexts; `evidence` MUST return nothing for them too.
- A **private task** (`tasks.visibility`, planned in
  `docs/design/private-task-execution.md` §4.6, NOT in the schema yet): the
  design's MVP rule is that private outcomes are not ingested into
  workspace-shared namespaces. Evidence follows it: `index_state = skipped`, no
  shared-namespace chunks. The objects are still stored and the read routes
  apply the same visibility filter as the task. A per-owner namespace is the
  design's Phase 2 and is not defined here; the `{workspaceId}:evidence:private:{taskId}`
  shape floated earlier is dropped because `namespace = {id}:{corpus}` is the
  invariant in the knowledge-store-retrieval spec.
- Until `tasks.visibility` ships, "private task" has no runtime meaning and the
  only enforced rule is the sensitive-workspace one.

## Read paths

- `GET /api/tasks/:id/evidence` lists a task's objects (lineage through
  `root_task_id`); with `?evidenceId=&tail=&grep=&range=` it returns redacted
  text. Response cap for chat and MCP is 64 KB with a `truncated` flag and a
  cursor. The route MUST verify the object's `task_id` or `root_task_id` matches
  `:id`.
- `GET /api/evidence?workspaceId=&prNumber=&kind=` resolves a PR number to its
  tasks' objects.
- **MCP action `read_evidence`** `{taskId | prNumber | evidenceId, kind?, tail?, grep?}`
  is a new `buildd` action: add it to `allActions` and `ACTION_AREA`
  (`packages/core/mcp-tools.ts`, `packages/core/mcp-tool-groups.ts`) at worker
  level. `manage_evidence_backends` is admin level.
- **Chat.** Two declarations are required, and the registry test plus the
  reach test fail if either is missing:
  1. `apps/web/src/lib/chat/registry.ts`: `read_evidence: one(read('GET /api/tasks/:id/evidence', 'GET /api/evidence'))`;
     `manage_evidence_backends` with `list`/`get` as reads and the rest
     `deferred(...)` with a reason.
  2. `apps/web/src/lib/chat/in-process-api.ts` `CHAT_ROUTES`: `/api/tasks/:id/evidence`
     with reach `byTask`, and `/api/evidence` with `requireQuery: ['workspaceId']`
     and rows filtering. `OwnedKind` has no `evidence` member, so the evidence
     id travels as a query parameter and the route, not the guard, checks it
     against `:id`. A route with a `:evidenceId` path segment would fail
     `routeReachProblems`.
- `get_task`, `get_pr` and `explain` include the object list (kind, bytes,
  first key lines) inline.
- The task page gets an **Evidence** tab: object list, tail viewer with grep,
  and a short-lived presigned GET for download (UI only, never chat).

## Failure behaviour

- Bucket unreachable or upload fails: the task continues, `upload_state = failed`,
  the compact PG record is still written, one retry is queued, health shows the
  backend `failing`.
- Byte cap hit: the writer keeps head and tail, drops the middle, and marks the
  manifest `complete = false`.
- Credential rotation: update the secret, re-verify. Objects the new credential
  cannot read are marked `unreadable`, never silently lost.

## Retention and deletion

- `expires_at = created_at + retention_days` (default 30; `buildd_default` fixed
  at 30). A daily job deletes expired objects, pointers and chunks. Today the
  managed bucket has no documented retention at all.
- BYO buckets get a recommended lifecycle rule as a backstop; Settings shows the
  snippet.
- Deleting a task, or `forget` on a workspace, deletes its objects, pointers and
  chunks.

## Security

- Presigned PUTs are scoped to one key and expire in 15 minutes.
- The probe warns if the probe object is publicly readable (anonymous GET
  succeeds).
- SSE options are passed on every PUT.
- Backend `endpoint` MUST be validated against private/link-local address
  ranges before the server connects (SSRF), since it is tenant-supplied.

## Acceptance criteria

- AC-1: GIVEN a team saves an S3-compatible backend WHEN verification runs THEN
  a passing PUT/GET/DELETE sets `status = ok`, and a failing probe sets
  `status = failing` without changing any task's status.
- AC-2: GIVEN a Bash tool_result with `is_error === true` and a seeded secret in
  its output WHEN the runner writes evidence THEN a `command_output` object
  exists in the BYO bucket and the seeded secret value is absent from it.
- AC-3: GIVEN a CI failure on a buildd-owned PR WHEN the webhook is handled THEN
  a `ci_job_log` object exists with pointer rows for both the retry task and its
  root task.
- AC-4: GIVEN a session with more than 200 tool calls (P2) WHEN it ends THEN the
  transcript manifest has `complete = true` and the first tool call is present.
- AC-5: GIVEN `read_evidence {prNumber, kind: "ci_job_log", grep: "fail"}` from
  chat WHEN the PR's task is in reach THEN the matching lines return within 64 KB;
  WHEN the task is outside reach THEN the call is refused.
- AC-6: GIVEN indexed evidence (P3) WHEN `query_knowledge corpus=evidence` is
  called with a phrase from the failure THEN the originating task's chunk is
  returned.
- AC-7: GIVEN a sensitive workspace with no BYO backend WHEN a task fails THEN no
  evidence object is written; GIVEN one with a BYO backend THEN objects are
  written and `index_state = skipped`.
- AC-8: GIVEN objects past `expires_at` (P4) WHEN the retention job runs THEN
  they are gone from the bucket, `evidence_objects` and `knowledge_chunks` within
  24h.
- AC-9: GIVEN a claim response for any worker WHEN it is serialised THEN no
  `evidence_storage_credential` value appears in it.
- AC-10: GIVEN an `endpoint` resolving to a private address WHEN a backend is
  saved THEN it is rejected with HTTP 400.
- AC-11: GIVEN a `tail` request of a 10 MB object WHEN read through the route
  THEN the response is at most 64 KB and `truncated` is true.

## Phasing

- **P1:** backend config + verification; `command_output`, `ci_job_log` and
  `test_report` writers; `evidence_objects`; `read_evidence` in MCP and chat.
  Alone this would have answered the incident above.
- **P2:** segmented transcripts with pre-eviction flush and manifests (removes
  the 200 cap); tool_result bodies in the transcript.
- **P3:** the `evidence` corpus: chunker, index sweep, `query_knowledge`,
  failure-signature link; `pr_diff`.
- **P4:** Evidence tab, retention job, lifecycle snippet, re-scan on redaction
  bump.

## Open questions (proposed default; work proceeds on the default)

- Teams without BYO: keep writing to buildd R2 (30d), or compact records only?
  Default: keep writing, 30d, non-sensitive workspaces only.
- Azure Blob / GCS native adapter? Default: S3-compatible only.
- Should `evidence` chunks feed `get_failure_analytics` signature matching
  directly? Default: yes, in P3.
- Private-task namespace once `tasks.visibility` ships: skip indexing (MVP) or
  a per-owner namespace? Default: skip.

## Code surface

- Runner: `apps/runner/src/session-diagnostics.ts` (`uploadSessionDiagnostics`,
  `buildSessionTranscript`), `apps/runner/src/workers.ts` (ring buffers,
  `createSecretRedactor` setup, tool_result branch),
  `apps/runner/src/buildd.ts` (`requestSessionUploadUrl`).
- Server: `apps/web/src/app/api/workers/[id]/session-upload-url/route.ts`,
  `apps/web/src/lib/storage.ts`, `apps/web/src/lib/storage-keys.ts`,
  `apps/web/src/lib/session-artifact-keys.ts`,
  `apps/web/src/lib/ci-failure-inspect.ts`.
- Data: `packages/core/db/schema.ts` (`secrets`, `knowledgeIngestJobs`),
  `packages/core/secrets/types.ts`, `packages/core/redaction.ts`.
- Knowledge: `packages/core/knowledge-store/types.ts`, `.../health.ts`,
  `packages/core/mcp-tools.ts` (`CORPORA`, `mirrorWorkProduct`).
- Chat: `apps/web/src/lib/chat/registry.ts`, `apps/web/src/lib/chat/in-process-api.ts`,
  `apps/web/src/lib/chat/reach-rules.ts`.

## Out of scope

- Moving `knowledge_chunks` or vectors out of Postgres.
- Replacing the compact `result.evidence` record (task 0c635dfe).
- General file hosting; artifacts keep their own store.
- A per-owner private namespace (waits on `tasks.visibility`).
