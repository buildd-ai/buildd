---
title: MCP Action Contracts
status: active
owner: max
last_verified: 2026-09-03
summary: The MCP server at /api/mcp MUST expose buildd, recall, learn and the deprecated buildd_memory over stateless Streamable HTTP, authenticate every call with a Bearer key, and gate actions by token privilege.
domain: mcp
surfaces: [packages/core/mcp-tools.ts, apps/web/src/app/api/mcp/route.ts, apps/web/src/app/api/github/pr/review/route.ts, apps/web/src/lib/pr-review-status.ts]
related: [auth-oauth-boundaries, knowledge-store-retrieval, mcp-connectors-and-roles]
keywords: [iserror, triggeractions, workeractions, register_skill, streamable http, http 405, request_pr_review, get_pr_review, adopted pr, waitfor]
verified_by: [apps/web/src/app/api/mcp/tools.test.ts, apps/web/src/app/api/mcp/route.tool-gating.test.ts, packages/core/__tests__/mcp-tools-admin-gated-actions.test.ts, packages/core/__tests__/mcp-tools-write-fence.test.ts, packages/core/__tests__/mcp-tools-workspace-guard.test.ts, packages/core/__tests__/mcp-tools-pr-review.test.ts, apps/web/src/app/api/github/pr/review/route.test.ts, apps/web/src/lib/pr-review-status.test.ts, apps/web/src/lib/pr-review-callback.test.ts]
supersedes: []
---
# MCP Action Contracts

**Capability statement**: The buildd MCP server at `/api/mcp` MUST expose four
tools over the Streamable HTTP MCP transport — `buildd` (task + admin actions),
`recall` and `learn` (knowledge read/write), and `buildd_memory` (deprecated,
routed for compatibility) — authenticate every request with a Bearer API key, and
return the correct action result or a structured `isError: true` response for
every supported action.

---

## Auth & Transport

**Invariants**:
- Every request MUST carry `Authorization: Bearer <key>` resolving to a known
  `accounts` row, or the server returns HTTP 401.
- The server is **stateless** — no SSE; `GET /api/mcp` returns HTTP 405.
- Actions are filtered by account `level`: `trigger` ⊂ `worker` ⊂ `admin`.
  A trigger token calling a worker-only action MUST receive `isError: true`.
- Workspace context is resolved from `?workspace=<id>` or `?repo=<name>` query
  params. When neither is provided the server attempts lazy resolution from the
  caller's task list (single-workspace accounts only).
- OAuth tokens with access to >1 workspace and no explicit `?workspace=` MUST
  receive an error on any `buildd_memory` write action (multi-workspace
  ambiguity guard).

**Acceptance criteria**:
- AC-1: WHEN a request is sent without `Authorization` THEN the server returns
  HTTP 401 with `{ "error": "Missing Authorization header" }`.
- AC-2: WHEN a request is sent with an invalid Bearer token THEN the server
  returns HTTP 401 with `{ "error": "Invalid API key" }`.
- AC-3: GIVEN a trigger-level token WHEN `claim_task` is called THEN the
  response contains `isError: true` (action not in `triggerActions`).
- AC-4: WHEN `GET /api/mcp` is called THEN the server returns HTTP 405.
- AC-5: GIVEN an OAuth token with >1 accessible workspace and no `?workspace=`
  param WHEN `buildd_memory` `save` is called THEN the response contains
  `isError: true` with a message referencing "multiple workspaces".

**Code surface**:
- Route: `apps/web/src/app/api/mcp/route.ts`
- Action lists: `packages/core/mcp-tools.ts` — `triggerActions`, `workerActions`,
  `adminActions`, `allActions`
- Auth: `apps/web/src/lib/api-auth.ts` — `authenticateApiKey()`

**Out of scope**: OAuth 2.1 PKCE flow for claude.ai MCP clients (see
`auth-oauth-boundaries.md`).

---

## `buildd` tool — worker-level actions

**Capability statement**: The `buildd` tool MUST execute any action from the
worker action set (`list_tasks`, `get_task`, `claim_task`, `update_progress`,
`complete_task`, `create_pr`, `update_task`, `create_task`, `create_artifact`,
`upload_artifact`, `list_artifacts`, `get_artifact`, `update_artifact`,
`emit_event`, `query_events`, `get_error_traces`, `list_artifact_templates`,
`suggest_schedule_update`, `post_note`, `list_schedules`, `trace_schedule`,
`get_task_messages`) and forward it to the corresponding API endpoint, returning
the result as plain text.

**Invariants**:
- `workerId` is auto-resolved from the `?worker=` query param when omitted in
  `update_progress` and `complete_task`.
- `workspaceId` accepts a UUID, a short repo name, or `owner/repo`.
- `create_task.missionId` is auto-inherited from the calling worker's task when
  not explicitly provided.
- `register_skill` with `filePath` or `repo` params MUST return `isError: true`
  (no filesystem access in remote MCP).

**Acceptance criteria**:
- AC-6: WHEN `list_tasks` is called with a valid worker token THEN the response
  contains a JSON-formatted list of tasks (may be empty).
- AC-7: WHEN `claim_task` is called with a trigger token THEN the response
  contains `isError: true`.
- AC-8: WHEN `register_skill` is called with `{ filePath: "/foo" }` THEN the
  response contains `isError: true` referencing "no filesystem access".
- AC-9: GIVEN an unknown action string THEN the response contains `isError: true`
  with a message referencing the unknown tool.

**Code surface**:
- Handler: `packages/core/mcp-tools.ts` — `handleBuilddAction()`
- Param descriptions: `buildParamsDescription()` in the same file
- Claim route: `apps/web/src/app/api/workers/claim/route.ts`

**Out of scope**: The full parameter contract for each action (that lives in the
per-capability specs and in the `buildParamsDescription` strings).

---

## On-demand PR review — `request_pr_review` / `get_pr_review`

**Capability statement**: An agent MUST be able to hand any open pull request in
a GitHub-linked workspace to a reviewer agent by number — including a PR buildd
did not open — and MUST be able to learn the outcome by polling, by bounded
long-poll, or by an https callback.

**Invariants**:
- A PR with no buildd worker is **adopted** before review: one task (status
  `completed`, `context.adoptedPr`) plus one worker row carrying `prNumber`,
  `prUrl` and the PR's head branch. Adoption exists so the verdict handler, the
  activity comment, auto-merge and the merge webhook all key off the same
  "worker that owns this PR" they already use — no parallel review path.
- Adoption MUST happen only after the PR reads back from GitHub as `open`. A
  closed, merged, or non-existent PR MUST NOT leave an adopted task behind.
- One reviewer per PR at a time. A pending/in-flight reviewer task MUST be
  returned as-is (`alreadyRequested`), and `force` MUST NOT stack a second
  reviewer onto it — two reviewers race each other's verdicts. `force` only
  re-reviews a review that already finished.
- On approval the effective `MergePolicy` decides whether buildd merges;
  on-demand review grants no extra merge authority. The response MUST state
  `autoMergeExpected` so a caller waiting on a merge knows whether waiting is
  pointless (`approve-only` and tier `human` never auto-merge).
- An explicitly requested `reviewerRole` that the workspace does not have MUST
  be an error, never a silent substitution to another persona.
- `terminal` is relative to `waitFor`: `verdict` settles at the verdict;
  `merge` keeps waiting through a request-changes retry loop but settles on a
  merge, a close, an escalation, a failed review, or an approval the policy
  leaves to a human. A merged or closed PR is terminal for both.
- A completed reviewer task with no `structuredOutput.verdict` MUST read as
  `review_failed`, never as an approval.
- `waitSeconds` is clamped to 45s — below the platform function limit — and a
  clamped wait MUST return `timedOut: true` rather than being killed mid-flight.
- A callback URL MUST be https (a verdict discusses unmerged code) and MUST be
  delivered at most once, guarded by an atomic `UPDATE … WHERE marker IS NULL …
  RETURNING` claim on the reviewer task, because both the verdict handler and
  the PR-close webhook can reach the same terminal point.
- Callback delivery is best-effort in both directions: a dead endpoint MUST NOT
  fail the worker report or the webhook, and a caller can always fall back to
  `get_pr_review`.

**Acceptance criteria**:
- AC-14: WHEN `request_pr_review` is called for an open PR with no buildd worker
  THEN a task + worker mapped to that `prNumber` are created, a reviewer task is
  dispatched, and the PR's activity comment shows "Reviewing changes".
- AC-15: WHEN `request_pr_review` is called while a reviewer task for that PR is
  pending or in progress THEN no second reviewer task is created, with or
  without `force`.
- AC-16: WHEN the PR is not open THEN the call returns HTTP 409 and no task or
  worker row is inserted.
- AC-17: GIVEN `waitSeconds: 600` WHEN `get_pr_review` long-polls a review that
  never settles THEN it returns within 45s with `timedOut: true` and a
  non-terminal status.
- AC-18: GIVEN a review requested with `callbackOn: "merge"` WHEN the reviewer
  approves but the PR has not merged THEN no callback is delivered; WHEN the PR
  later merges THEN exactly one callback is POSTed.
- AC-19: WHEN a requested `reviewerRole` is absent from the workspace THEN the
  call returns HTTP 400 naming the available roles and dispatches nothing.

**Code surface**:
- Route: `apps/web/src/app/api/github/pr/review/route.ts`
- Status mapping + role choice + callback POST:
  `apps/web/src/lib/pr-review-status.ts`
- DB reads, long-poll, single-fire callback claim:
  `apps/web/src/lib/pr-review-request.ts`
- Reviewer task creation: `apps/web/src/lib/reviewer.ts` — `createReviewerTask()`
- Verdict-time delivery: `apps/web/src/app/api/workers/[id]/route.ts`
- Close-time delivery: `apps/web/src/app/api/github/webhook/route.ts`

**Out of scope**: Choosing what the reviewer agent looks for (that is the role's
prompt and `docs/specs/scheduled-task-merge-policy.md`), and any merge authority
beyond the workspace policy.

---

## `buildd_memory` tool — knowledge actions (deprecated)

**Capability statement**: The `buildd_memory` tool MUST provide `context`,
`search`, `save`, `get`, `update`, `delete`, and `query_knowledge` actions
against the team's `memories` table and workspace knowledge store, scoped to the
resolved team and workspace.

**Status**: superseded by `recall` (read) and `learn` (write) in #1944; still
routed for compatibility. Every dispatch emits a `[buildd_memory-deprecated]`
log line so removal can be decided on evidence. `consolidate_knowledge` and
`query_knowledge` were promoted to the `buildd` admin action set and are NOT
deprecated.

**Invariants**:
- Writes (`save`, `update`, `delete`) against an ambiguous OAuth multi-workspace
  token MUST be rejected (returns `isError: true`).
- When the caller's team cannot be resolved the server MUST return
  `isError: true` with "Memory store not available". (Before #1944 this
  invariant was phrased in terms of an env var, MEMORY_API_URL, which no longer
  exists in any code path — the standalone service was absorbed into the buildd
  DB. Deliberately not in backticks: it is a historical note, not a claim about
  live code, and the spec linter reads a backticked identifier as the latter.)
- `query_knowledge` queries the `PgVectorStore` with the resolved
  `{workspaceId}:{corpus}` namespace; it falls back to lexical search when
  `VOYAGE_API_KEY` is absent.

**Acceptance criteria**:
- AC-10: WHEN `context` is called with a valid admin token THEN the response
  contains markdown-formatted memory text (may be "No memories yet.").
- AC-11: WHEN any client-requiring action is called and the team cannot be
  resolved THEN the response contains `isError: true` with "Memory store not
  available".
- AC-12: GIVEN an OAuth token with >1 workspace and no `?workspace=` WHEN `save`
  is called THEN the response contains `isError: true` mentioning "multiple
  workspaces".
- AC-13: WHEN `query_knowledge` is called with `corpus: "task"` THEN results
  include only chunks with `corpus = 'task'` in `knowledge_chunks`.

**Code surface**:
- Handler: `packages/core/mcp-tools.ts` — `handleMemoryAction()`
- Memory store: `packages/core/memory-store.ts` — `MemoryStore` (in-process Drizzle queries)
- Knowledge store: `packages/core/knowledge-store/pg-vector-store.ts`
- Memory provisioning: `apps/web/src/app/api/mcp/route.ts` —
  `getMemoryStoreForTeam()`

**Out of scope**: MCP Resources (`buildd://tasks/pending`,
`buildd://workspace/memory`, `buildd://workspace/skills`) — read-only, no auth
differences.
