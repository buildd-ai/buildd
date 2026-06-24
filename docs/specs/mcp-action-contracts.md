# MCP Action Contracts

**Capability statement**: The buildd MCP server at `/api/mcp` MUST expose exactly
two tools (`buildd` and `buildd_memory`) over the Streamable HTTP MCP transport,
authenticate every request with a Bearer API key, and return the correct action
result or a structured `isError: true` response for every supported action.

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
`auth-oauth-boundaries.md`). The in-process stdio MCP server
(`packages/core/buildd-mcp-server.ts`) used by the local runner.

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

## `buildd_memory` tool — knowledge actions

**Capability statement**: The `buildd_memory` tool MUST provide `context`,
`search`, `save`, `get`, `update`, `delete`, and `query_knowledge` actions
against the team's memory service and workspace knowledge store, scoped to the
resolved team and workspace.

**Invariants**:
- Writes (`save`, `update`, `delete`) against an ambiguous OAuth multi-workspace
  token MUST be rejected (returns `isError: true`).
- When `MEMORY_API_URL` is not configured the server MUST return `isError: true`
  with "Memory service not configured".
- `query_knowledge` queries the `PgVectorStore` with the resolved
  `{workspaceId}:{corpus}` namespace; it falls back to lexical search when
  `VOYAGE_API_KEY` is absent.

**Acceptance criteria**:
- AC-10: WHEN `context` is called with a valid admin token and configured memory
  service THEN the response contains markdown-formatted memory text (may be
  "No memories yet.").
- AC-11: WHEN any write action is called on a server with `MEMORY_API_URL` unset
  THEN the response contains `isError: true` with "Memory service not configured".
- AC-12: GIVEN an OAuth token with >1 workspace and no `?workspace=` WHEN `save`
  is called THEN the response contains `isError: true` mentioning "multiple
  workspaces".
- AC-13: WHEN `query_knowledge` is called with `corpus: "task"` THEN results
  include only chunks with `corpus = 'task'` in `knowledge_chunks`.

**Code surface**:
- Handler: `packages/core/mcp-tools.ts` — `handleMemoryAction()`
- Memory client: `packages/core/memory-client.ts`
- Knowledge store: `packages/core/knowledge-store/pg-vector-store.ts`
- Memory provisioning: `apps/web/src/app/api/mcp/route.ts` —
  `getMemoryClientForTeam()`

**Out of scope**: The internal memory service API at `memory.buildd.dev`
(separate repo `buildd-ai/memory`). MCP Resources (`buildd://tasks/pending`,
`buildd://workspace/memory`, `buildd://workspace/skills`) — read-only, no auth
differences.
