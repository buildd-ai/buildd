---
title: Organizer Context
status: active
owner: max
last_verified: 2026-10-15
summary: Organizer prompts MUST include prior work and bounded current workspace context while degrading safely on retrieval failure.
domain: missions
surfaces: [apps/web/src/lib/mission-context.ts, apps/web/src/lib/workspace-state-context.ts]
related: [task-state-machine, claim-gate-legibility, mission-completion, mission-surface-audit]
verified_by: [apps/web/src/lib/workspace-state-context.test.ts, apps/web/src/lib/knowledge-context.test.ts]
assertions:
  - id: prior-work-guard
    type: test_file
    path: apps/web/src/lib/knowledge-context.test.ts
  - id: guard-1
    type: test_file
    path: apps/web/src/lib/workspace-state-context.test.ts
---
# Organizer Context

**Capability statement**: Organizer prompts MUST include prior work and bounded current workspace context while degrading safely on retrieval failure.

## Organizer prior-work retrieval contract

**Capability statement**: Every mission planning pass — whether triggered by cron
(heartbeat) or manually — MUST inject a "Related prior work" block retrieved from
the KnowledgeStore before the organizer decides what tasks to create.

**Corpora queried** (all best-effort, failures silently skipped):

| Corpus | Namespace | Purpose |
|--------|-----------|---------|
| `memory` | `{teamId}:memory`, narrowed to the workspace's project | Lessons and gotchas from this workspace |
| `task` | `{workspaceId}:task` | Prior task outcomes |
| `pr` | `{workspaceId}:pr` | Pull request diffs (change history) |
| `code` | `{workspaceId}:code` | Current code index |
| `plan` | `{workspaceId}:plan` | Prior decomposition plans |

Cap: 3 hits per corpus to bound prompt growth.

**Memory scoping**: the memory namespace is shared by the whole team, so a
memory hit MUST be kept only when its `memories` row carries the calling
workspace's project key (`keepOwnProjectMemoryHits` in
`packages/core/memory-hit-scope.ts`, the same rule `recall` uses). A workspace
with no resolvable key (sensitive, or sharing a key with a sensitive workspace)
gets no memory section, and a memory with no project is never shown. The
corpora hint counts only the workspace's own memories.

**Rendering**: Each hit shows `[score] title | type/status | PR ref | age`. Task
hits with `success=true` and a `prUrl` surface the PR number. Memory hits show age.

**Stale-baseline flag**: Any task hit where `metadata.success === true` and
`metadata.prUrl` is set and `createdAt` is within the last 14 days renders with:
> ⚠ MAY ALREADY BE SHIPPED — read the merged diff before specing.

**Path-based lookup**: When active tasks in the mission carry a `pathManifest`,
`buildKnowledgeContext` runs an additional query against `{workspaceId}:pr` using
the path list as query text. Results appear in a separate "Recent work on relevant
paths" section. Composes with PR #1130 overlap serialization.

**Decomposition skip rule**: If a retrieved item scores ≥0.82 cosine similarity
AND its task card `createdAt` is within 14 days with a PR, the organizer MUST NOT
create a task for that scope. Required action: `post_note type=decision` naming
the PR and explaining why decomposition was skipped.

**Invariants**:
- Retrieval failure MUST NOT fail or block a heartbeat or planning pass.
- Sensitive workspaces (`dataClass = 'sensitive'`) skip the `memory` corpus query.

**Code surface**:
- `apps/web/src/lib/knowledge-context.ts` — `buildKnowledgeContext()`
- `apps/web/src/lib/mission-context.ts` — `buildMissionContext()`, `buildHeartbeatContext()`

**Acceptance criteria**:
- AC-16: GIVEN a mission with prior related work WHEN heartbeat context is built
  THEN the "Related prior work" block is present with score, status, and PR ref.
- AC-17: GIVEN a task card with `success=true`, `prUrl` set, `createdAt` 3 days ago
  WHEN knowledge context is built THEN the stale-baseline warning is rendered.
- AC-18: GIVEN the same task card with `createdAt` 30 days ago
  THEN no stale-baseline warning appears.
- AC-19: GIVEN active tasks with `pathManifest` entries
  WHEN knowledge context is built THEN a path-scoped PR query fires.
- AC-20: GIVEN the knowledge store throwing on all queries
  WHEN heartbeat or planning context is built THEN no error is raised and the
  rest of the context is returned normally.

---


## Organizer situational awareness contract

**Capability statement**: Every organizer pass MUST inject a "Workspace Situational
Awareness" block scoped to the trigger cause. This gives the organizer a live
picture of what else is happening in the workspace (sibling missions, held path
claims, open PRs, parent initiative, budget pressure) without a full workspace
dump on every pass.

**Cause enum**:

| Cause | Trigger |
|-------|---------|
| `task_completed` | `resolveCompletedTask` calls the organizer |
| `pr_merged` | GitHub webhook fires after a PR merges |
| `conflict_escalation` | Worker hits a 409 on `check_path_claim` |
| `claim_409` | Same as conflict_escalation (MCP tool variant) |
| `mission_evaluate` | Normal organizer/heartbeat evaluation pass |
| `first_decomposition` | First evaluation of a freshly-created mission |
| `fallback` | Cause unknown or not supplied |

**Section matrix** (which sections render per cause):

| Section | task_completed | pr_merged | conflict_* | mission_evaluate | first_decomposition | fallback |
|---------|:-:|:-:|:-:|:-:|:-:|:-:|
| What landed | ✓ | ✓ | | | | |
| Blocking claim | | | ✓ | | | |
| Sibling missions | | | | ✓ | ✓ | ✓ |
| Held path claims | | | | ✓ | ✓ | ✓ |
| Open PRs | | | | ✓ | ✓ | |
| Parent initiative | | | | ✓ | ✓ | |
| Budget | | | | ✓ | ✓ | |

**Character budget per section** (hard caps — oversized input truncates, never errors):

| Section | Cap (chars) |
|---------|-------------|
| What landed | 400 |
| Blocking claim | 400 |
| Sibling missions | 600 (≤5 shown) |
| Held path claims | 400 (≤10 shown) |
| Open PRs | 400 (≤5 shown) |
| Parent initiative | 200 |
| Budget | 100 |

**Data sources** (one DB query per section, no N+1):

1. **Path claims** — `path_claims WHERE released_at IS NULL`, joined with `tasks` for
   taskTitle and missionId. Age always shown so stale rows are visually obvious.
2. **Sibling missions** — `missions` + aggregated task counts in a single GROUP BY query.
3. **Open PRs** — `workers WHERE pr_url IS NOT NULL AND merged_at IS NULL AND
   pr_lifecycle_status IS DISTINCT FROM 'merged'/'closed'`.
4. **Parent initiative** — `initiatives.progressCache` + `kpiState` (no additional mission
   join; the cache holds the rollup).
5. **Budget** — `teams.monthlyCostUsd / monthlyBudgetUsd` as a one-line percentage.

**Integration points**:
- `buildMissionContext()` reads `templateContext.cause` (defaults to `mission_evaluate`)
  and `templateContext.causeData` to pass into `buildWorkspaceStateContext`.
- `buildHeartbeatContext()` always calls with `cause = 'mission_evaluate'` (heartbeat
  is a broad evaluation pass, not a targeted event).

**Invariants**:
- A source failure (query error, missing data) MUST degrade to omitting that section —
  never block context assembly or propagate an error.
- All five querier calls fire concurrently via `Promise.allSettled`.
- `task_completed` / `pr_merged` / `conflict_*` causes make ZERO querier calls —
  they render inline from `causeData` alone.
- `fallback` omits initiative, open PRs, and budget to cap cost on unknown-trigger passes.

**Acceptance criteria**:
- AC-21: GIVEN cause = `task_completed` WHEN `buildWorkspaceStateContext` runs THEN
  the output contains "What landed" and does NOT contain "Sibling missions".
- AC-22: GIVEN cause = `conflict_escalation` and `blockingMissionId` is a non-null
  string WHEN the block is rendered THEN it says "different mission" with the mission ID.
- AC-23: GIVEN cause = `mission_evaluate` and a sibling mission holds a path claim
  WHEN context is built THEN the holder's taskId and missionId are visible.
- AC-24: GIVEN an `initiativeId` and cause = `mission_evaluate` and the initiative has
  KPI state THEN "KPIs: N/M met" appears in the output.
- AC-25: GIVEN cause = `mission_evaluate` and `initiativeId = null` THEN "Parent
  initiative" section is absent.
- AC-26: GIVEN all querier methods throw WHEN context is built THEN a non-empty string
  is returned without error propagation.
- AC-27: GIVEN cause = `fallback` THEN budget and initiative sections are absent even
  when those queriers would succeed.
- AC-28: GIVEN 20 held claims WHEN the claims section renders THEN at most 10 are shown.

**Code surface**:
- `apps/web/src/lib/workspace-state-context.ts` — `buildWorkspaceStateContext()`
- `apps/web/src/lib/mission-context.ts` — integration in `buildMissionContext()`,
  `buildHeartbeatContext()`
- `apps/web/src/lib/workspace-state-context.test.ts` — 25 tests covering all causes,
  degradation, and budget enforcement

---

**Out of scope**: The sibling contracts linked in the frontmatter.
