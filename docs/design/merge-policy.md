# Merge Policy Primitive — Design Spec

> **Status:** Proposed — awaiting Max's approval before any implementation begins.
> **Task:** 33ab675e · Branch: `buildd/33ab675e-spec-merge-policy-primitive-au`
> **Dependencies:** Builds on `docs/design/worker-pr-automerge.md` (auto-merge mechanics),
> `docs/design/review-gate-ux.md` (blocked-on-merge UX), `docs/design/settings-ia-refactor.md`
> (settings IA — policy config lives under `/app/settings/workspace`).

---

## Problem Statement

Worker PRs stall waiting for the sole human to notice and merge. Missions silently block on unmerged
PRs with no indication that a merge is the unblock. The current `autoMergeOnGreenCI` /
`autoMergeMaxLines` / `autoMergeDenyPaths` fields in `workspaces.gitConfig` provide mechanism-only
auto-merge with no judgment layer and no visibility into why a PR wasn't merged.

Three failure modes today:

1. **Silent stalls** — deny-path hits, oversized diffs, and dirty-state conflicts result in a
   `console.warn` with no notification and no human-actionable queue.
2. **No judgment** — auto-merge is binary: size and path checks only. It cannot evaluate whether a
   PR's scope is correct, its spec conformance, or obvious regressions. A PR that touches
   `packages/core/db/schema.ts` might auto-merge into prod because it's small enough.
3. **No visibility** — missions show no indication that 'work done, unmerged' is a distinct state
   from 'in progress', and there is no way to configure the merge behavior per-mission.

This spec introduces a **merge policy primitive**: a three-tier configurable object (workspace
default + per-mission override) that provides a consistent, auditable, UI-visible merge governance
layer.

---

## 1. Data Model — MergePolicy Object

### 1.1 Policy tiers

```typescript
type MergePolicyTier =
  | 'auto-threshold'  // Tier 1 — existing CI-gated mechanism with size/path constraints
  | 'agent-review'    // Tier 2 — agent reviewer role judges before merging
  | 'human';          // Tier 3 — explicit human gate (no auto-merge)
```

### 1.2 MergePolicy shape

```typescript
interface MergePolicy {
  tier: MergePolicyTier;

  // Tier 1 config (all optional; defaults match current gitConfig behavior)
  threshold?: {
    maxLines?: number;           // total additions+deletions; default 800
    maxSourceLines?: number;     // non-test lines only; default = maxLines
    denyPaths?: string[];        // block if any touched file starts with these prefixes
  };

  // Tier 2 config (required when tier = 'agent-review')
  agentReview?: {
    reviewerRole: string;        // slug of the reviewer skill registered in workspace_skills
    escalateToPaths?: string[];  // deny-path-like list; reviewer MUST escalate to human if any touched
    maxConfidenceThreshold?: number; // 0–1; reviewer escalates if confidence < this value (default 0.6)
    gateCondition?: 'approve-and-merge' | 'approve-only'; // default 'approve-and-merge'
  };

  // Shared: how long a PR can sit at this tier before the platform notifies
  stallNotifyMinutes?: number;   // default: 30 for human/agent-review, 5 for auto-threshold
}
```

### 1.3 Storage

`MergePolicy` is stored in two places:

**Workspace default**: `workspaces.gitConfig.mergePolicy: MergePolicy`. Added as a new optional key
on the existing `WorkspaceGitConfig` JSONB — no schema migration required.

**Mission override**: `missions.mergePolicy: MergePolicy | null`. New nullable JSONB column on the
`missions` table. When set, it overrides the workspace default for all PRs produced by that
mission's tasks.

```sql
-- migration: add mergePolicy to missions
ALTER TABLE missions ADD COLUMN merge_policy jsonb;
```

Resolution order: **mission.mergePolicy** → **workspace.gitConfig.mergePolicy** → legacy
`gitConfig.autoMergeOnGreenCI/autoMergePR` → default `auto-threshold` with existing defaults.

### 1.4 Migration from legacy gitConfig fields

No existing workspace configuration is broken. The webhook handler resolves policy as:

```typescript
function resolvePolicy(workspace: Workspace, mission?: Mission | null): MergePolicy {
  // 1. Mission override takes precedence
  if (mission?.mergePolicy) return mission.mergePolicy;

  // 2. Workspace explicit policy
  if (workspace.gitConfig?.mergePolicy) return workspace.gitConfig.mergePolicy;

  // 3. Legacy fields → synthesize an auto-threshold policy
  const legacyAutoMerge = workspace.gitConfig?.autoMergeOnGreenCI
    ?? workspace.gitConfig?.autoMergePR
    ?? true;

  if (!legacyAutoMerge) return { tier: 'human' };

  return {
    tier: 'auto-threshold',
    threshold: {
      maxLines: workspace.gitConfig?.autoMergeMaxLines ?? 800,
      denyPaths: workspace.gitConfig?.autoMergeDenyPaths ?? [],
    },
  };
}
```

The legacy fields remain valid and are never stripped. Teams that have not set `mergePolicy`
explicitly continue with identical behavior. When a team sets `mergePolicy` for the first time via
the UI, the UI pre-fills the threshold values from the legacy fields to prevent invisible changes.

---

## 2. Tier 1 — auto-threshold

This tier is the existing CI-gated mechanism, formalized.

### 2.1 Evaluation (unchanged logic, now named)

`evaluateAutoMergeSafety` in `apps/web/src/app/api/github/webhook/route.ts` already implements this.
After the merge policy is introduced, this function reads from the resolved `MergePolicy.threshold`
rather than directly from `gitConfig` fields.

Gates (in order):
1. All CI check suites passed
2. `mergeable_state` not `dirty` (conflict → attempt rebase; if rebase fails, escalate)
3. No touched file starts with a `denyPaths` prefix
4. `additions + deletions` ≤ `maxLines` (or `source lines` ≤ `maxSourceLines` when both set)

When all gates pass: squash-merge + branch delete.

When any gate blocks: emit `MERGE_POLICY_BLOCKED` mission-feed event with reason, send Pushover.

### 2.2 Deny-path escalation

A deny-path hit under `auto-threshold` does NOT silently drop the PR. It transitions the PR to
the **escalation inbox** (see §6.4) with reason `deny-path: <matched path>`. This matches the
behavior the `worker-pr-automerge.md` spec (S2, S5) prescribes, now unified under the policy
framework.

---

## 3. Tier 2 — agent-review

This is the new core of the merge policy primitive.

### 3.1 Reviewer role definition

The reviewer role is a standard buildd `workspaceSkill` with `isRole: true`. A default reviewer
role is seeded at workspace creation alongside Organizer/Builder/Researcher.

**Default reviewer role config**:

```typescript
{
  slug: 'reviewer',
  name: 'Reviewer',
  isRole: true,
  model: 'claude-sonnet-5',    // use best available judgment model
  maxTurns: 5,                 // short review session
  allowedTools: [
    'mcp__buildd__buildd',     // read task/artifact context
    // NO edit/write/bash — reviewer is read-only
  ],
  canDelegateTo: [],
  background: false,
  color: '#6366f1',
  content: `
You are a code reviewer for AI-generated pull requests. You receive:
- The PR diff
- The task description that produced this PR
- The linked spec artifact(s) for the task
- Doctrine context (one-branch-per-unit, pathManifest conformance, retry-continues-branch)

Your job is to judge ONE question: should this PR merge as-is, or are there specific problems
that must be fixed on the SAME branch before merging?

Judge on these criteria:
1. ONE-WORK-UNIT ADHERENCE: The PR touches only files in the task's pathManifest. No scope creep.
2. PATH-MANIFEST CONFORMANCE: Every file in pathManifest is touched. No missing deliverables.
3. SPEC CONFORMANCE: What was built matches what the spec/task description asked for.
4. OBVIOUS REGRESSIONS: Test failures, broken imports, incomplete migrations.

Output format:
- verdict: 'approve' | 'request-changes' | 'escalate'
- confidence: 0.0–1.0
- summary: one sentence
- feedback: (for request-changes only) specific, actionable changes required, referencing file paths
- escalationReason: (for escalate only) why a human must decide

ESCALATION IS REQUIRED when:
- The diff touches schema migration files (drizzle/*.sql, packages/core/db/schema.ts)
- The diff touches paths in the workspace's escalateToPaths list
- Your confidence is below the workspace's maxConfidenceThreshold
- The PR is a release PR (base branch is main or the workspace's prodBranch)
- You detect a possible security issue

Do NOT approve a PR that touches the DB schema. Escalate it.
  `
}
```

### 3.2 Invocation

**Trigger**: PR creation. When `handlePullRequestEvent` fires with `action: 'opened'` and the
resolved policy is `agent-review`, enqueue a reviewer task instead of attempting auto-merge.

**Task creation**:

```typescript
// In handlePullRequestEvent, after worker lookup:
if (policy.tier === 'agent-review') {
  await createReviewerTask({
    workspaceId,
    taskId: worker.taskId,
    prNumber: pr.number,
    prUrl: pr.html_url,
    headSha: pr.head.sha,
    reviewerRole: policy.agentReview!.reviewerRole,
    missionId: task?.missionId,
  });
  return; // do not attempt auto-merge
}
```

`createReviewerTask` creates a task with:
- `title`: `[reviewer] PR #${prNumber}: ${task.title}`
- `roleSlug`: `policy.agentReview.reviewerRole`
- `category`: `'review'` (new category value, additive)
- `outputSchema`: `ReviewerTaskOutput` JSON Schema (verdict/confidence/summary/feedback/escalationReason)
- `context`: `{ reviewerFor: taskId, prNumber, headSha, originalTaskId: task.id }`
- `missionId`: inherited from original task
- `release`: `'false'` — reviewer tasks never trigger releases

**Context injected into reviewer agent**:
1. PR diff from GitHub API (`/repos/{owner}/{repo}/pulls/{prNumber}/files`)
2. Original task description and `pathManifest`
3. All `artifact` records linked to the original task (spec docs, summaries)
4. Sibling mission tasks with their status (open/merged) for context
5. Workspace doctrine (one-branch-per-unit, deny paths list)

The reviewer agent receives these via its `CLAUDE.md` (injected at claim time via the existing
`role-config.ts` context-building path, which already supports `mcpServers` and env injection).

### 3.3 Judgment criteria detail

| Criterion | Pass signal | Fail signal |
|---|---|---|
| One-work-unit | `prFiles ⊆ pathManifest ∪ lockfiles` | Files outside pathManifest without clear necessity |
| PathManifest conformance | All pathManifest entries present in diff | Declared files missing (incomplete delivery) |
| Spec conformance | Task desc checklist items present in diff | Required features absent; wrong interface shape |
| Obvious regressions | No deleted test files; no broken imports visible in diff | Test files deleted; `.test.ts` error patterns; incomplete migration (SQL without corresponding schema) |

### 3.4 Outcomes

**`approve`** (confidence ≥ threshold, no escalation triggers):
- Post `REVIEWER_APPROVED` mission-feed event with summary
- Call `tryAutoMergeWorkerPr` with the existing merge path (squash-merge + branch delete)
- If `policy.agentReview.gateCondition === 'approve-only'`: post note but do NOT merge; surface
  in the escalation inbox for human to execute the merge

**`request-changes`** (reviewer found fixable problems):
- Do NOT merge
- Post `REVIEWER_REQUEST_CHANGES` mission-feed event with `feedback` text
- Create a retry task for the original task's worker:
  - `iteration = (task.iteration ?? 0) + 1`
  - `failureContext = reviewerFeedback`
  - `baseBranch = worker.branch` (MUST continue on the same branch — no new branch)
  - `parentTaskId = task.id`
- The retry task pushes fixes to the existing branch → new CI run → new PR-opened event →
  new reviewer task (capped at `maxIterations` from the original task, default 3)
- Post mission note: `"PR #${prNumber}: reviewer requested changes (iteration ${n}/3). Retry queued on same branch."`

**`escalate`** (escalation triggers hit):
- Do NOT merge; do NOT create retry
- Surface PR in escalation inbox (§6.4) with `escalationReason`
- Post `REVIEWER_ESCALATED` mission-feed event
- Send Pushover: `"Reviewer escalated PR #${prNumber}: ${escalationReason}"`
- The human sees the PR in the escalation inbox and can merge (one-tap) or request changes
  via a freeform note that becomes the retry's `failureContext`

### 3.5 Escalation triggers (hard rules)

These override the reviewer's own confidence and force `escalate` regardless:

| Trigger | Detection |
|---|---|
| Schema migration | PR touches `drizzle/*.sql` OR `packages/core/db/schema.ts` |
| Deny-path | Any touched file path starts with `policy.agentReview.escalateToPaths[]` |
| Low confidence | Reviewer output `confidence < policy.agentReview.maxConfidenceThreshold` |
| Release PR | `pr.base.ref` is the workspace's `prodBranch` (main or releaseConfig.prodBranch) |

The reviewer agent is instructed to output `escalate` in these cases, but the webhook handler
also enforces them by inspecting the PR file list before dispatching the reviewer — fail-safe.

### 3.6 Audit trail

Every reviewer decision is persisted as a mission-feed event with full payload:

```typescript
interface ReviewerAuditEvent {
  type: 'REVIEWER_APPROVED' | 'REVIEWER_REQUEST_CHANGES' | 'REVIEWER_ESCALATED';
  label: string;                  // human-readable summary line
  metadata: {
    prNumber: number;
    prUrl: string;
    reviewerTaskId: string;
    verdict: 'approve' | 'request-changes' | 'escalate';
    confidence: number;
    summary: string;
    feedback?: string;            // for request-changes
    escalationReason?: string;    // for escalate
    headSha: string;
    policyTier: 'agent-review';
    iteration: number;
  };
}
```

Events are queryable via `query_events` MCP action. They appear in the mission timeline as
audit chips (§6.3).

### 3.7 Retry branch doctrine

**The reviewer's `request-changes` outcome MUST NOT open a new branch.** The retry task receives
`baseBranch = worker.branch` so it pushes fixes to the existing branch. This is non-negotiable:
new branches produce new PRs, which accumulate merge conflicts and defeat the one-branch-per-unit
doctrine established in PR #1051.

Implementation checkpoint: `createReviewerTask` must pass `baseBranch` into the retry task's
`context.baseBranch` field, and the worker runner must honor it (the worktree-utils path already
supports `context.baseBranch`).

---

## 4. Tier 3 — human

When `tier: 'human'`, auto-merge is fully disabled. PRs are never merged by the platform.
`evaluateAutoMergeSafety` is not called.

**Behavior**:
- On PR creation: emit `MERGE_HELD_HUMAN_GATE` mission-feed event; surface in escalation inbox
- Dependent tasks show `blocked:gate` (per `review-gate-ux.md` §2.1)
- One-tap merge from escalation inbox / task page / mission timeline (§6.2)
- No reviewer task is spawned

**Use case**: compliance-sensitive workspaces, schema-only missions, or manual testing environments
where the human must always be the last gate.

---

## 5. UI Spec

### 5.1 Blocked-on-merge as an explicit state

**New display state: `blocked:unmerged`**

This extends the `blocked:gate` state from `review-gate-ux.md` with richer context about which
policy tier is holding the PR and how long it has been waiting.

A task row in the 'blocked' group of the Activity list (§8.2 of review-gate-ux.md) now shows:

```
┌────────────────────────────────────────────────────────────────┐
│  ⏸  feat: MCP connector OAuth discovery                        │
│     Blocked · awaiting merge · PR #1134 · Tier: Agent Review  │
│     Waiting 14 min                             [View PR ↗]    │
└────────────────────────────────────────────────────────────────┘
```

Fields:
- **Tier badge**: `Auto` / `Agent Review` / `Human Gate` — shows which policy tier is active
- **Wait duration**: `Waiting {N} min/hr` — derived from `worker.prCreatedAt` or task completion
- **[View PR ↗]** — GitHub deep-link

Mission progress bar must distinguish 'work done, unmerged' from 'in progress':

```
  ████████████████░░░░░░  8/10 done  ·  2 awaiting merge
```

The `awaiting merge` count is the number of tasks with `status = 'completed' AND
worker.prUrl IS NOT NULL AND worker.mergedAt IS NULL`. This is distinct from `in-progress`
(workers running) and `pending` (not yet started).

### 5.2 One-tap approve+merge (mobile-first)

**Design constraint**: this feature is used from a phone. It must be reachable in ≤2 taps and
require no modal navigation.

#### 5.2.1 Escalation inbox tap (primary path)

In the escalation inbox (§6.4), each PR row has a prominent `[Merge]` button. Tapping it:
1. Shows an **inline confirmation** below the button (NOT a modal sheet):
   ```
   Merging will automatically start N queued tasks.  [Cancel]  [Confirm Merge]
   ```
2. On confirm: calls `POST /api/prs/[prNumber]/merge` (per `review-gate-ux.md` §5.1)
3. On success: row removes itself; a `[✓ Merged]` inline toast confirms for 2s

No modal maze. The confirmation is a 2-button inline affordance that takes the same tap target
footprint as the original button.

#### 5.2.2 Mission timeline tap

From the mission timeline, a gate chip (§5.4) shows `[Merge]`. Same inline confirmation.

#### 5.2.3 Task page banner tap

Same as `review-gate-ux.md` §2.2 — the task page banner `[Merge]` button uses the same inline
confirmation pattern.

#### 5.2.4 Human-gate tier: no reviewer task

For `tier: 'human'`, the merge button is always available immediately. For `tier: 'agent-review'`
with `gateCondition: 'approve-only'`, the merge button appears only after reviewer approves (the
button is disabled with tooltip `"Awaiting agent review"` until then).

### 5.3 Agent-review surfacing in the mission timeline

In the mission detail page (existing task timeline), reviewer tasks surface as **inline verdict
chips** on the task node they reviewed. Verdict chips are NOT separate task rows.

Layout:

```
┌──────────────────────────────────────────────────────────────┐
│  ✓  feat: MCP connector OAuth discovery       PR #1134 open  │
│     ──────────────────────────────────────────────────────── │
│     🤖 Agent Review                                          │
│        ✓ Approved (confidence 0.91)                          │
│        "Diff conforms to spec. All pathManifest files        │
│         present. No regressions detected."                   │
│        → Merging automatically…                              │
└──────────────────────────────────────────────────────────────┘
```

For `request-changes`:

```
│     🤖 Agent Review                                          │
│        ↩ Changes Requested (iteration 1/3)                   │
│        "Missing handler for token refresh edge case in       │
│         apps/web/src/lib/mcp-oauth.ts:142. See retry task."  │
│        → Retry queued on same branch (buildd/884c8b72-…)     │
```

For `escalated`:

```
│     🤖 Escalated to you                                      │
│        "PR touches packages/core/db/schema.ts — schema       │
│         migrations require human review."                    │
│        [Merge]  [Request Changes ↗]                          │
```

The `[Request Changes ↗]` link opens a freeform input (inline expandable, not a modal) where the
human types feedback. Submitting creates a retry task with `failureContext = humanFeedback` on the
same branch.

### 5.4 Mission timeline gate chip

Between task phases in the mission timeline, a gate chip shows when PRs are awaiting merge.
This extends the chip defined in `review-gate-ux.md` §3 with policy-tier context:

```
╔════════════════════════════════════════════════════════════╗
║  ⏸  3 PRs awaiting merge                                   ║
║     Policy: Agent Review · Waiting 22 min                  ║
║     PR #1134 · Auto-reviewing…  [View]                     ║
║     PR #1135 · Approved — merging  [View]                  ║
║     PR #1136 · Escalated to you  [Merge]  [Changes]        ║
╚════════════════════════════════════════════════════════════╝
```

Each row in the gate chip is a separate PR. The `[Merge]` / `[Changes]` actions in the chip use
the same inline confirmation pattern (§5.2).

### 5.5 Escalation inbox

**Location**: prominently on the Home page (`/app/home`), above the existing "Waiting on you"
section from `review-gate-ux.md` §1 — or merged into it with a policy-tier filter.

The escalation inbox shows PRs that require human action because:
- The reviewer escalated (`verdict: 'escalate'`)
- The PR hit a deny-path in `auto-threshold`
- `tier: 'human'` (always requires human merge)

**Inbox row layout**:

```
┌─────────────────────────────────────────────────────────────────┐
│  ⚠  PR #1136 — feat: connector credential storage              │
│     buildd  ·  Schema change  ·  Waiting 8 min                 │
│     "PR touches packages/core/db/schema.ts"                    │
│                        [Review PR ↗]  [Request Changes]  [Merge]│
└─────────────────────────────────────────────────────────────────┘
```

Escalation reason is always shown as a one-line explainer.

**Badge**: a red badge on the Home nav item (mobile bottom nav, desktop sidebar) showing the count
of PRs awaiting human action. This badge is visible from any page — PRs in the escalation inbox
are never buried.

Badge count derives from:
```sql
SELECT COUNT(DISTINCT w.pr_number)
FROM workers w
JOIN tasks t ON t.id = w.task_id
WHERE w.pr_url IS NOT NULL
  AND w.merged_at IS NULL
  AND (
    -- human-gate tier
    (/* resolved policy tier = 'human' */)
    OR
    -- agent-review escalated
    EXISTS (
      SELECT 1 FROM mission_notes mn
      WHERE mn.type = 'reviewer_escalated'
        AND mn.metadata->>'prNumber' = w.pr_number::text
    )
    OR
    -- auto-threshold deny-path
    (/* MERGE_POLICY_BLOCKED reason contains 'deny-path' */)
  )
  AND t.workspace_id = ANY(user_workspace_ids)
```

**Empty state**: inbox section is hidden when count = 0.

**Stall notification**: if a PR sits in the escalation inbox for > `stallNotifyMinutes` without
human action, send a Pushover reminder: `"PR #${prNumber} has been waiting ${minutes}m for your
review"`. Send at most once per PR per stall window (no repeat spam).

### 5.6 Policy configuration UI

**Location**: `/app/settings/workspace/[workspaceId]` — a new sub-page under the Connections
Settings IA (§2.2 of `settings-ia-refactor.md`), accessible as a tab or from the workspace
detail card. This is workspace-scoped config, not team-level — it lives one level deeper than
`/app/settings`.

**Navigation path**: Settings → (workspace name) → Merge Policy

**Page layout**:

```
Merge Policy
─────────────────────────────────────────────────────
Workspace default                      [Edit]

  Tier:  ○ Auto-Threshold  ● Agent Review  ○ Human Gate
                            ↑ active

  Threshold (applies to Auto-Threshold tier)
    Max lines:        800
    Deny paths:       drizzle/  packages/core/db/schema.ts

  Agent Review
    Reviewer role:    Reviewer (reviewer)       [Change]
    Escalate paths:   (same as deny paths above) [Edit]
    Max confidence:   0.6
    Gate condition:   Approve and Merge

  Stall notify:       30 min

─────────────────────────────────────────────────────
Per-Mission Override
  [Search missions…]
  ↓
  Mission: Generic MCP Connector Support
    Override: Human Gate                       [Edit] [Remove]
```

**Active policy indication on mission header**:

The mission header row (mission list + mission detail page header) shows a small policy chip:

```
  [Mission name]  ·  Auto Review  ·  4/10 done  ·  2 awaiting merge
```

The policy chip shows the effective tier (resolved: mission override or workspace default). Tapping
the chip navigates to the policy config page.

**Editing the policy**: tapping [Edit] opens an inline drawer (not a new page) with a segmented
control for the tier and collapsible threshold/agent-review config sections. Save writes to
`workspace.gitConfig.mergePolicy` or `mission.mergePolicy`. Pre-fills threshold values from
legacy `gitConfig` fields on first open.

---

## 6. Interlocks

### 6.1 orchestrationMode / manual missions

**Manual missions** (`orchestrationMode: 'manual'`) suppress orchestrator task spawning, but do
NOT change merge policy behavior. A manual mission can have `tier: 'agent-review'` and reviewer
tasks will still be spawned by the PR webhook — reviewers are triggered by PR events, not the
orchestrator heartbeat.

**Interlock rule**: reviewer tasks created by the merge policy are NOT subject to the manual-mode
guard (`orchestrationMode === 'manual'` only blocks planner/heartbeat task creation, not
review-triggered tasks). The `createReviewerTask` function bypasses the
`if (mission.orchestrationMode === 'manual') return` guard in `runMission`.

**Mission-level `requiresReview` flag** (existing, on missions and tasks): this flag has a
narrower meaning — it holds the PR for human review regardless of policy tier. The merge policy
coexists with this flag. Resolution:

```
requiresReview = true → always behave as tier 'human' for this task/mission,
                         regardless of the workspace/mission mergePolicy.
```

The `requiresReview` flag remains the emergency/explicit override for teams that want certain
tasks to always require human eyes.

### 6.2 Release pipeline

The merge policy applies only to **worker PRs** (feature branches → dev). It does NOT apply to
**release PRs** (dev → main or branch_merge releases). The webhook handler already distinguishes
these two paths:

- `handleCheckSuiteEvent` → worker PR auto-merge → now policy-governed
- `handleReleasePrCiSuccess` → release PR merge → NOT policy-governed (release is a separate
  mechanism; policy tier 'human' on a feature branch does not block the release merge)

**Why**: the release policy is already configurable via `releaseConfig.trigger` (PR #1003:
`every_merge`, `on_mission_complete`, `manual`, `scheduled`). The merge policy governs
individual worker PRs; the release policy governs when and how the accumulated dev changes ship
to prod. They are orthogonal.

**Escalation escalation**: if a worker PR is escalated to human under `agent-review` policy, and
the mission has `releaseConfig.trigger = 'on_mission_complete'`, the release is deferred
automatically — the mission cannot reach `all-tasks-terminal` while that PR is unmerged. No
special interlock code is needed; the existing all-tasks-terminal gate naturally holds.

### 6.3 dependsOn / gateCondition unblocking

The existing `dependsOn` + `gateCondition: 'merged'` mechanism (PR #971) already gates dependent
tasks on the upstream PR being merged (`workers.mergedAt IS NOT NULL`). The merge policy
determines WHEN that merge happens.

**Chain**: upstream task completes → PR opens → policy tier evaluated → (auto-threshold: merge
immediately if safe) / (agent-review: reviewer runs, then merge) / (human: human taps Merge) →
`workers.mergedAt` set → `checkDependsOnResolved` fires → dependent tasks unblock.

No new interlock code is needed for `dependsOn` — the merge policy just governs the path to
`mergedAt` being set. The existing `checkDependsOnResolved` fix from `review-gate-ux.md` §5.3
is a prerequisite (it must not fire `TASK_UNBLOCKED` before `mergedAt` is set).

**Mission-level `dependsOnMission`** (PR #971): same chain — a downstream mission blocked until
upstream PRs are merged is unblocked when `mergedAt` is set. Merge policy governs how fast that
happens; `dependsOnMission` gates on the result.

---

## 7. Schema Changes

### 7.1 missions.merge_policy (required)

```sql
ALTER TABLE missions ADD COLUMN merge_policy jsonb;
```

This is a nullable JSONB column. No default value — null means "use workspace default".

```typescript
// In packages/core/db/schema.ts, missions table:
mergePolicy: jsonb('merge_policy').$type<MergePolicy | null>(),
```

### 7.2 workspaces.gitConfig (no migration, additive key)

`MergePolicy` is a new optional key on `WorkspaceGitConfig`. No SQL migration required — it's a
new field in the existing JSONB blob.

```typescript
// In packages/core/db/schema.ts, WorkspaceGitConfig interface:
mergePolicy?: MergePolicy;
```

### 7.3 tasks.category (additive enum value)

Add `'review'` as a new category value for reviewer tasks. This is an additive change to the
text column — no migration required (Drizzle validates at app layer, not DB layer for text columns).

### 7.4 mission_notes.type (additive value)

Add new note types for reviewer audit trail:

```typescript
type: 'reviewer_approved' | 'reviewer_request_changes' | 'reviewer_escalated'
```

These join the existing types (`decision`, `question`, `warning`, `suggestion`, `update`, `reply`,
`guidance`, `review_needed`) — additive, no migration needed.

---

## 8. Build Tasks

Filed after Max approves this spec. Each is independently shippable in the order listed.

| # | Title | Files | Notes |
|---|---|---|---|
| BT-1 | **Add `merge_policy` JSONB to missions schema** | `packages/core/db/schema.ts`, `packages/core/drizzle/` | Schema + migration. Run `bun db:generate`. |
| BT-2 | **Add `MergePolicy` type to shared types** | `packages/shared/src/types.ts` | `MergePolicy`, `MergePolicyTier` interfaces. |
| BT-3 | **`resolvePolicy()` — legacy gitConfig migration shim** | `apps/web/src/app/api/github/webhook/route.ts` | Reads `mission.mergePolicy` → `workspace.gitConfig.mergePolicy` → legacy fields. Tests: verify each fallback chain. |
| BT-4 | **Reviewer role seed** | `apps/web/src/lib/default-roles.ts` | Seed 'reviewer' role on workspace creation. Idempotent (upsert). |
| BT-5 | **`createReviewerTask()` + reviewer invocation on PR open** | `apps/web/src/app/api/github/webhook/route.ts`, `apps/web/src/lib/reviewer.ts` | On PR open + `tier: 'agent-review'`, spawn reviewer task with diff/artifact context. Tests: reviewer task created with correct context fields. |
| BT-6 | **Reviewer task output schema + context injection** | `apps/web/src/lib/reviewer.ts`, `apps/web/src/lib/role-config.ts` | JSON Schema for ReviewerTaskOutput; inject PR diff + task artifacts into reviewer CLAUDE.md. |
| BT-7 | **Reviewer outcome handling: approve path** | `apps/web/src/app/api/workers/[id]/route.ts` | On reviewer task complete with `verdict: 'approve'`: emit mission event, call tryAutoMergeWorkerPr. Tests: approve + auto-merge fires. |
| BT-8 | **Reviewer outcome handling: request-changes path** | `apps/web/src/app/api/workers/[id]/route.ts`, `apps/web/src/lib/retry.ts` | On `request-changes`: post mission note, create retry task with `baseBranch = worker.branch`. Guard: iteration ≤ maxIterations. Tests: retry task inherits branch; no new branch opened. |
| BT-9 | **Reviewer outcome handling: escalate path** | `apps/web/src/app/api/workers/[id]/route.ts` | On `escalate`: post mission note, send Pushover, surface in escalation inbox. Tests: Pushover fires with escalation reason. |
| BT-10 | **Pre-flight escalation guard (schema / deny-path detect before reviewer dispatch)** | `apps/web/src/app/api/github/webhook/route.ts` | Skip reviewer task for schema-change and deny-path PRs; directly escalate with reason. Tests: schema-touching PR skips reviewer, goes to escalation inbox. |
| BT-11 | **Merge policy `stallNotifyMinutes` cron** | `apps/web/src/app/api/cron/` | Periodic check (e.g., every 5 min) for PRs stalled > stallNotifyMinutes; send Pushover reminder once per window. |
| BT-12 | **Mission merge-policy JSONB in manage_missions API** | `apps/web/src/app/api/missions/route.ts`, MCP | `manage_missions create/update` accept `mergePolicy`. |
| BT-13 | **Mission progress bar: 'awaiting merge' count** | Mission detail page components | Extend progress bar to show `awaiting merge` separately from `in progress` (§5.1). |
| BT-14 | **Activity list: tier badge + wait duration on blocked rows** | `apps/web/src/components/StatusChip.tsx` | Extend `<StatusChip>` with `policyTier` and `waitingMinutes` props (§5.1). |
| BT-15 | **Escalation inbox on Home page** | `apps/web/src/app/app/(protected)/home/page.tsx` | Merge into or above "Waiting on you" section; badge on Home nav (§5.5). |
| BT-16 | **Agent-review verdict chips in mission timeline** | Mission detail timeline component | Reviewer audit events render as inline chips on the reviewed task node (§5.3). |
| BT-17 | **One-tap merge inline confirmation pattern** | Shared merge-confirm component | Inline 2-button confirm (no modal); reused by inbox, mission timeline gate chip, task page banner (§5.2). |
| BT-18 | **Mission timeline gate chip: multi-PR with tier context** | Mission detail page | Extend review-gate-ux.md §3 gate chip with policy tier + per-PR reviewer status rows (§5.4). |
| BT-19 | **Escalation inbox: stall notification** | `apps/web/src/app/api/cron/` or `apps/web/src/lib/notify.ts` | Notify once per stallNotifyMinutes if PR still in inbox (§5.5). Can share implementation with BT-11. |
| BT-20 | **Policy config UI: workspace merge policy settings page** | `apps/web/src/app/app/(protected)/settings/workspace/[workspaceId]/page.tsx` | Tier selector, threshold fields, agent-review config, per-mission overrides list (§5.6). |
| BT-21 | **Policy chip on mission header** | Mission list + mission detail header | Small tier badge; taps to policy config page (§5.6). |

**Recommended ship order**:

Phase 1 (data + backend, no UI):
BT-1 → BT-2 → BT-3 → BT-4 → BT-12

Phase 2 (reviewer machinery):
BT-5 → BT-6 → BT-10 → { BT-7, BT-8, BT-9 } (parallel)

Phase 3 (UI):
BT-11 → BT-17 → { BT-13, BT-14, BT-15 } (parallel) → BT-19 → { BT-16, BT-18 } (parallel) → { BT-20, BT-21 } (parallel)

Phase 1 ships as a dark-deployment (no visible user change). Phase 2 brings the reviewer live.
Phase 3 exposes the full UI.

---

## 9. Out of Scope

- **Full PR diff rendering inside buildd**: link to GitHub for diff review; buildd provides only
  the Merge/Request-Changes actions.
- **PR comments from buildd**: the reviewer's feedback is delivered as a `failureContext` retry
  parameter and a mission note — NOT as GitHub PR comments (avoids polluting GitHub review thread
  with automated comments, which the user has not requested).
- **Multi-reviewer panels**: single reviewer role per policy. Majority-vote reviewer panels are
  a future enhancement.
- **Cross-PR merge arbitration / fan-out gate**: no "wait for all PRs, then batch merge" in this
  spec. Each PR is evaluated independently by the policy. The `dependsOn` graph handles sequencing.

---

## 10. Test Plan

### Unit tests

| File | Test |
|---|---|
| `apps/web/src/lib/reviewer.test.ts` | `resolvePolicy()` returns `auto-threshold` from legacy `autoMergePR: true` |
| same | `resolvePolicy()` returns `human` from legacy `autoMergePR: false` |
| same | Mission `mergePolicy` overrides workspace policy |
| same | Pre-flight escalation guard returns 'escalate' for schema-touching PRs |
| `apps/web/src/app/api/github/webhook/route.test.ts` | PR open + agent-review policy → reviewer task created (no tryAutoMerge called) |
| same | PR open + human policy → no reviewer task, PR surfaces in inbox |
| `apps/web/src/app/api/workers/[id]/route.test.ts` | Reviewer complete with approve → tryAutoMerge called |
| same | Reviewer complete with request-changes → retry task created with `baseBranch = worker.branch` |
| same | Reviewer complete with escalate → Pushover sent, no retry task |
| same | Retry task iteration > maxIterations → escalate instead of retry |

### Integration smoke tests

- Worker PR open + workspace policy `auto-threshold` → auto-merges on green CI (existing behavior unchanged)
- Worker PR open + workspace policy `agent-review` → reviewer task spawned; approve → merges
- Worker PR open + `agent-review` policy + schema file touched → pre-flight escalation fires (no reviewer task spawned)
- Mission policy override `human` → PR never auto-merges; shows in escalation inbox
- Reviewer `request-changes` → retry task uses same branch; no new PR opened

---

## 11. References

- `docs/design/worker-pr-automerge.md` — existing auto-merge mechanics (gaps G1–G5; specs S1–S5)
- `docs/design/review-gate-ux.md` — blocked-on-merge UX (BT-1..BT-12); `<StatusChip>`; merge endpoint
- `docs/design/settings-ia-refactor.md` — settings IA (policy config lives under workspace sub-page)
- PR #971 — `dependsOnMission` + `gateCondition: 'merged'`
- PR #1003 — `releaseConfig.trigger` (release policy, orthogonal to this spec)
- PR #1051 — one-branch-per-unit doctrine + `create_pr` dedup
- PR #1121 — review-gate-ux.md spec (merge endpoint, `checkDependsOnResolved` fix)
- PR #1155 — `orchestrationMode: 'auto' | 'manual'`
