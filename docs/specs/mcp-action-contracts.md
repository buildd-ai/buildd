---
title: MCP Action Contracts
status: active
owner: max
last_verified: 2026-10-08
summary: /api/mcp MUST serve the buildd_<group> action tools (legacy buildd only to runners predating them), recall and learn over stateless Streamable HTTP, Bearer-authenticate every call and gate actions by privilege.
domain: mcp
surfaces: [packages/core/mcp-tools.ts, apps/web/src/app/api/mcp/route.ts, apps/web/src/app/api/github/pr/review/route.ts, apps/web/src/lib/pr-review-status.ts]
related: [auth-oauth-boundaries, knowledge-store-retrieval, mcp-connectors-and-roles]
keywords: [iserror, triggeractions, workeractions, register_skill, streamable http, http 405, request_pr_review, get_pr_review, adopted pr, waitfor]
verified_by: [apps/web/src/app/api/mcp/tools.test.ts, apps/web/src/app/api/mcp/route.tool-gating.test.ts, apps/web/src/app/api/mcp/route.group-tools.test.ts, packages/core/__tests__/mcp-tool-groups.test.ts, packages/core/__tests__/mcp-response-budgets.test.ts, packages/core/__tests__/mcp-tools-admin-gated-actions.test.ts, packages/core/__tests__/mcp-tools-write-fence.test.ts, packages/core/__tests__/mcp-tools-workspace-guard.test.ts, packages/core/__tests__/mcp-tools-pr-review.test.ts, apps/web/src/app/api/github/pr/review/route.test.ts, apps/web/src/lib/pr-review-status.test.ts, apps/web/src/lib/pr-review-callback.test.ts]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "mcp-transport"
    type: "route"
    method: "POST"
    path: "/api/mcp"
    file: "apps/web/src/app/api/mcp/route.ts"
  - id: "request-pr-review"
    type: "route"
    method: "POST"
    path: "/api/github/pr/review"
    file: "apps/web/src/app/api/github/pr/review/route.ts"
  - id: "action-privilege-tests"
    type: "test_file"
    path: "packages/core/__tests__/mcp-tools-admin-gated-actions.test.ts"
---
# MCP Action Contracts

**Capability statement**: The buildd MCP server at `/api/mcp` MUST serve the
`buildd` actions over the Streamable HTTP MCP transport — as one tool per action
group (`buildd_<group>`) or, on the legacy surface, the one `buildd` tool — plus
`recall` and `learn` (knowledge read/write) and `buildd_memory` (deprecated,
routed for compatibility); authenticate every request with a Bearer API key; and
return the correct action result or a structured `isError: true` response for
every supported action.

---

## Tool listing — group tools

**Invariants**:
- Every `buildd` action belongs to exactly one group (`ACTION_AREA` /
  `mcpGroupOf`); chat's tool groups come from the same table.
- `tools/list` on the `groups` surface lists `buildd_<group>` for each group the
  token level has an action in; its `action` enum is those actions plus `help`.
  `buildd` is not listed there but MUST stay callable with the same routing.
- `groups` is the standard surface for every session; no URL parameter or
  server flag selects a surface. The one exception: a runner worker session
  (`?worker=`) whose runner has not advertised `CAPABILITY_MCP_GROUP_TOOLS` on
  its heartbeat (looked up by the worker's account and local UI URL) gets the
  `legacy` surface, which lists `buildd` alone. Unknown (no URL, no heartbeat,
  lookup error) counts as not advertised. The legacy surface is a
  compatibility fallback for runners that predate group tools, to be removed.
- The runner recognises a buildd action on any action tool name
  (`isBuilddActionTool`: `mcp__buildd__buildd` or `mcp__buildd__buildd_<group>`)
  plus `input.action`, never one exact name: `create_pr` arrives on
  `buildd_work`.
- A wrong-group action the token level may not call MUST get the same
  not-available-at-your-level error as `help`, not a pointer to a tool the
  level is not shown.
- A group tool called with another group's action MUST return a one-line
  `isError: true` naming the right tool, and run nothing. Its own actions run
  exactly as on `buildd`, including level refusals.
- `help` with `params.action` returns that action's long parameter docs.
- A group tool's `params` schema types the fields common questions need
  (`MCP_GROUP_PARAMS`), each with one short description, and stays an open
  object: untyped fields pass through. A level sees only the fields its listed
  actions take.
- A group tool's description gives a line (signature + summary) only to its
  `listed` actions (`ACTION_LISTING`, usage-derived and dated: called often, or
  named by a skill, role prompt or runner prompt); the rest are named on one
  closing `More: a, b — call help {action} for docs.` line. Both kinds stay in
  the `action` enum and dispatch identically.
- The listing is narrowed by who is behind the session, not only its level: a
  session with no person (API key or per-task token) is not shown the
  personal-role skill actions it would always be refused, and an orchestration
  task token is shown only the admin actions its own mission allows
  (`ORCHESTRATION_TASK_TOKEN_ADMIN_ACTIONS`). A runner worker session therefore
  lists no admin-only action. The legacy surface is not narrowed.
- Budget: the whole `groups` surface at admin level (group tools plus
  `recall`, `learn` and the other listed tools) stays under 6k estimated tokens
  (JSON length / 3.6, as `chat-eval static` counts); the test holds it under
  5.1k, and a task-token worker session under 4k.
- The busiest actions cap what they send by default and every cut names how
  much it cut and the param or action that returns the rest (`explain` on a
  workspace pages ranked summaries with `limit`/`offset`; `claim_task` previews
  the description and lists only open PRs touching the task's paths; `get_task`,
  `get_pr`, `manage_missions get` take `all: true`). Sizes are held by
  `packages/core/__tests__/mcp-response-budgets.test.ts`.
- A call with no `params` object uses the fields beside `action` as its params.
  A sub-action passed as the tool's `action` (e.g. `update`) MUST get an
  `isError: true` naming the action and `params.action`, and run nothing.

**Acceptance criteria**:
- AC-21: GIVEN a trigger token WHEN tools/list is called THEN the group tools
  are exactly `buildd_tasks`, `buildd_work`, `buildd_artifacts`,
  `buildd_schedules`.
- AC-22: WHEN `buildd_missions` is called with `action: "list_runners"` THEN the
  result is `isError: true` naming `buildd_analytics`.
- AC-23: WHEN `buildd` is called with any action THEN it dispatches as before.
- AC-24: GIVEN a worker session whose runner advertised `CAPABILITY_MCP_GROUP_TOOLS`
  WHEN tools/list is called THEN it lists the group tools and not `buildd`;
  GIVEN one whose runner did not THEN it lists `buildd` and no group tool,
  whatever the URL says.

**Analytics contract**:
- `buildd_analytics` groups explain, errors, failure/gate analytics, budget,
  usage, runners, Dispatch transport health (`dispatch_health {workspaceId?}`,
  see task-dispatch-authority.md "Observability"), manifest coverage and
  path-claim statistics. The existing Analyst role declares it; aggregate
  reads remain available at worker level.
- `get_manifest_coverage {workspaceId?, missionId?, window?}` reports tasks
  created in the window as concrete, advisory wildcard or missing manifests,
  with a fractional concrete share and workspace/mission/kind breakdowns.
- `get_path_claim_stats` takes the same filters and counts ledger decisions:
  claimed, blocked, deadlock and rejected, split by transport surface. Successful
  calls start at instrumentation rollout; older ledger rows only recorded
  refusals. Invalid and unauthorized requests are excluded.
- `get_decision_stats` takes the same filters and counts the
  orchestration decision ledger (`orchestration_decisions`,
  `orchestration_manifest_predictions`): totals, applied/suggested/fallback,
  labelled vs unlabelled (an `orchestration_touch_labels` row exists for the
  task), by decision group, by UTC day and by fallback reason. It carries each
  workspace's opt-in state, so zero rows read as "capability disabled" when the
  team never opted in rather than as missing evidence. Served by
  `/api/stats/coordination?metric=orchestrationDecisions`; that metric is never
  part of the unfiltered coordination report.
- Change-intent conflict warnings enter `family=gate` as `change_intent` /
  `warned`, once per delivered warning note (both sides of a conflict).
- Accepted path claims are telemetry, excluded from friction ranking and bypass
  rates. Shared dispatch calls REST; it MUST stay DB-free for every transport.
- The coordinated scope name is `analytics:read` for per-user/cost detail.
  The token-scopes task owns scope enforcement at both REST and MCP layers;
  role declarations alone do not enforce access. Existing level behavior remains
  compatible until that shared scope model lands.

**Code surface**:
- Registry: `packages/core/mcp-tool-groups.ts` — `ACTION_AREA`, `mcpGroupOf`
- Listing and routing: `apps/web/src/app/api/mcp/tools.ts` — `listMcpTools`,
  `routeGroupToolCall`, `mcpToolSurfaceFor`
- Old-runner check: `apps/web/src/lib/mcp-request-scope.ts` — `workerRunnerSupportsGroupTools`
- Runner tool-name match: `packages/shared/src/tool-names.ts` — `isBuilddActionTool`

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
- A `review_failed` status MUST carry `failureReason` when one can be found:
  the review task's own worker's `error` (free text), falling back to a
  human-readable label derived from that worker's `exitCause` (e.g. "the
  review worker never started"). This is a DIFFERENT worker than the one
  `get_pr` reports on — that one owns the PR being reviewed; this one is the
  reviewer session that crashed before producing a verdict, which is the only
  place the crash reason lives once the review task's own `result`/`context`
  come back empty. Null when no reviewer worker row exists or it recorded
  neither field (e.g. a pre-migration row).
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
  dispatched, and the PR's activity comment shows "Reviewing".
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
- AC-20: GIVEN a reviewer task ended `failed`/`cancelled` (or `completed` with
  no verdict) AND its own worker row has `error` set WHEN `get_pr_review` is
  called THEN the response's `status.failureReason` equals that `error` text,
  and the MCP tool's rendered text includes a `Reason:` line. GIVEN `error` is
  null but `exitCause` is set THEN `failureReason` is the corresponding human
  label instead. GIVEN neither is set, or no reviewer worker row can be found,
  THEN `failureReason` is null and the MCP text says no reason was recorded.

**Code surface**:
- Route: `apps/web/src/app/api/github/pr/review/route.ts`
- Status mapping + role choice + callback POST:
  `apps/web/src/lib/pr-review-status.ts`
- DB reads, long-poll, single-fire callback claim (incl. `findReviewTaskWorker`,
  the reviewer's own worker row for `failureReason`):
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
