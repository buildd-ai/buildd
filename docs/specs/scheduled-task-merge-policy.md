---
title: Scheduled-task merge policy override
status: active
owner: max
last_verified: 2026-08-27
summary: A task schedule MUST be able to declare a MergePolicy that overrides the workspace and mission default for every task it creates, acting as a floor that risk-class escalation can still raise.
domain: tasks
surfaces: [apps/web/src/lib/merge-policy.ts, apps/web/src/app/api/cron/schedules/route.ts, apps/web/src/lib/workspace-policy.ts, packages/shared/src/types.ts]
related: [db-migration-gates, external-cron-triggers, mission-task-lifecycle]
keywords: [merge_policy, auto-threshold, resolvepolicy, taskscheduletemplate, maxlines, changelog schedule]
supersedes: []
---

# Scheduled-task merge policy override

**Capability statement**: A task schedule MUST be able to declare its own
`MergePolicy` that overrides the workspace/mission default for every task it
creates, so that mechanical recurring tasks (e.g. CHANGELOG, knowledge
consolidation) auto-merge on CI green without requiring human or agent review.

---

## Problem

Scheduled recurring tasks inherit the effective merge policy of their
workspace/mission. When the workspace default is `agent-review` or `human`,
every scheduled task — including purely mechanical bookkeeping tasks — lands in
REVIEW and accumulates unmerged PRs until manually attended. The CHANGELOG
updater (PR #1826) was the first reported instance.

The fix must reuse the existing `MergePolicy` type and `resolvePolicy()`
precedence chain rather than inventing a parallel concept.

---

## Config surface

### `TaskScheduleTemplate.mergePolicy` (new field)

`packages/shared/src/types.ts` — extend the existing `TaskScheduleTemplate`
interface:

```ts
export interface TaskScheduleTemplate {
  title: string;
  description?: string;
  mode?: TaskModeValue;
  priority?: number;
  runnerPreference?: RunnerPreferenceValue;
  requiredCapabilities?: string[];
  context?: Record<string, unknown>;
  mergePolicy?: MergePolicy;          // NEW — overrides workspace/mission default
}
```

When set, the value is validated with `parseMergePolicy()` and stored verbatim
in the schedule's `taskTemplate` JSONB. Absent → no override (existing
behaviour).

### `tasks.mergePolicy` (new column)

`packages/core/db/schema.ts` — add a nullable JSONB column to the `tasks`
table, between `requiresReview` and `scheduleId`:

```ts
mergePolicy: jsonb('merge_policy').$type<MergePolicy | null>(),
```

Migration: `packages/core/drizzle/0NNN_add_task_merge_policy.sql`
```sql
ALTER TABLE tasks ADD COLUMN merge_policy jsonb;
```

No default, no NOT NULL — existing tasks are unaffected.

### Task creation from schedule

`apps/web/src/app/api/cron/schedules/route.ts:634` — the `db.insert(tasks)`
call MUST propagate `template.mergePolicy` when present:

```ts
...(template.mergePolicy ? { mergePolicy: template.mergePolicy } : {}),
```

The value is written as-is (already validated at schedule-save time). No
additional validation at creation time.

---

## Precedence chain (updated)

`apps/web/src/lib/merge-policy.ts` — `resolvePolicy()` gains a new step at
position 2 (between `task.requiresReview` and `mission.mergePolicy`):

```
1. task.requiresReview = true  →  { tier: 'human' }      (explicit human gate)
2. task.mergePolicy            →  parsed value             ← NEW
3. mission.mergePolicy
4. mission.requiresReview = true  →  { tier: 'human' }
5. workspace.gitConfig.mergePolicy
6. DEFAULT_MERGE_POLICY  ({ tier: 'auto-threshold', threshold: { maxLines: 800 } })
```

`resolvePolicy()` signature change:

```ts
export function resolvePolicy(
  workspace: { gitConfig?: WorkspaceGitConfig | null },
  mission?: { mergePolicy?: MergePolicy | null; requiresReview?: boolean } | null,
  task?: { requiresReview?: boolean; mergePolicy?: MergePolicy | null } | null,
): MergePolicy {
  if (task?.requiresReview) return { tier: 'human' };
  if (task?.mergePolicy)   return parseMergePolicyRead(task.mergePolicy);  // NEW
  if (mission?.mergePolicy) return parseMergePolicyRead(mission.mergePolicy);
  if (mission?.requiresReview) return { tier: 'human' };
  if (workspace.gitConfig?.mergePolicy) return parseMergePolicyRead(workspace.gitConfig.mergePolicy);
  return DEFAULT_MERGE_POLICY;
}
```

All callers of `resolvePolicy()` already pass the `task` object from a DB
query — adding `mergePolicy` to the selected columns is the only call-site
change needed.

---

## Risk-class interaction

`applyPolicyConfigToMergePolicy()` in
`apps/web/src/lib/workspace-policy.ts:211` is called **after** `resolvePolicy()`
at every webhook merge entry point. It can only **upgrade** the tier
(auto-threshold → agent-review → human), never downgrade it.

Consequence: a schedule-level `mergePolicy` of `{ tier: 'auto-threshold' }`
acts as a **floor**, not a ceiling. If the PR touches a path matched by a
workspace `policyConfig` risk class (e.g. `auth_and_secrets`,
`ci_deploy_config`), the risk class escalation fires and overrides the
schedule-level policy upward. The scheduled task is not a bypass for risk
classes.

---

## Blast radius guard

`threshold.maxLines` (default 800) applies even when no explicit threshold is
set on the schedule. Operators SHOULD set a tighter `maxLines` for mechanical
schedules to prevent runaway diffs from self-merging:

```json
{
  "tier": "auto-threshold",
  "threshold": { "maxLines": 200 }
}
```

A scheduled task whose PR exceeds `maxLines` is NOT auto-merged; instead it
falls through to the stall-notify path (default 5 minutes for auto-threshold).

`threshold.denyPaths` is also honoured, but risk-class escalation already covers
the common danger paths (`.github/workflows/`, migration files, auth paths), so
explicit denyPaths are optional for schedules.

---

## Validation

`POST /api/schedules` and `PATCH /api/schedules/[id]` MUST validate
`taskTemplate.mergePolicy` with `parseMergePolicy()` before persisting. An
invalid policy MUST be rejected with HTTP 400 and a message identifying the
offending field.

---

## Migration: CHANGELOG schedule

The "Auto Changelog" schedule (ID `79aa99bf-f490-49df-b7ca-83dfa82ac933`) is the
first consumer. Its `taskTemplate` MUST be updated to:

```json
{
  "title": "Update CHANGELOG.md with recent commits",
  "mergePolicy": {
    "tier": "auto-threshold",
    "threshold": { "maxLines": 200 }
  }
}
```

The 200-line cap is a conservative guard: a valid CHANGELOG update touches one
file and adds fewer than 50 lines per run. A diff exceeding 200 lines signals
something went wrong and MUST NOT auto-merge.

The schedule update is applied via `manage_workspaces`-equivalent API or direct
`update_schedule` call; no code change is required after the implementation ships.

---

## Failure modes

| Scenario | Behaviour |
|---|---|
| Schedule sets `auto-threshold`; PR touches `auth_and_secrets` path | Risk class escalates to `human` (or `agent-review` per preset). Schedule-level policy is overridden upward. |
| Schedule sets `auto-threshold`; diff exceeds `maxLines` | PR is NOT auto-merged. Stall notify fires after `stallNotifyMinutes` (default 5 min for auto-threshold). |
| Schedule has no `mergePolicy`; workspace default is `human` | Task inherits `human` tier — existing behaviour, no regression. |
| `mergePolicy` stored in template is malformed at task-creation time | `parseMergePolicyRead()` logs a warning and falls through to `mission.mergePolicy` / workspace default rather than throwing. |
| `task.requiresReview = true` AND `task.mergePolicy` set | `requiresReview` wins (step 1 in precedence chain). `task.mergePolicy` is ignored. |

---

## Acceptance criteria

- **AC-1**: GIVEN a schedule with `taskTemplate.mergePolicy = { tier: 'auto-threshold', threshold: { maxLines: 200 } }`, WHEN the schedule fires, THEN the created task row has `merge_policy = { "tier": "auto-threshold", "threshold": { "maxLines": 200 } }`.

- **AC-2**: GIVEN a task with `mergePolicy = { tier: 'auto-threshold' }` and a workspace whose `gitConfig.mergePolicy = { tier: 'human' }`, WHEN `resolvePolicy(workspace, null, task)` is called, THEN it returns `{ tier: 'auto-threshold' }`.

- **AC-3**: GIVEN a task with `mergePolicy = { tier: 'auto-threshold' }`, WHEN the PR touches a path matched by a `policyConfig` risk class whose preset action is `human`, THEN `applyPolicyConfigToMergePolicy()` returns `{ tier: 'human' }` (escalation overrides schedule-level floor).

- **AC-4**: GIVEN a task with `mergePolicy = { tier: 'auto-threshold', threshold: { maxLines: 200 } }` and a PR with 250 changed lines, WHEN the CI check-suite event fires, THEN the PR is NOT auto-merged (diff exceeds threshold) and the stall-notify path fires.

- **AC-5**: GIVEN a schedule with `taskTemplate.mergePolicy = { tier: 'invalid-tier' }`, WHEN `POST /api/schedules` is called, THEN the server returns HTTP 400 with an error identifying `mergePolicy.tier`.

- **AC-6**: GIVEN a task with both `requiresReview = true` and `mergePolicy = { tier: 'auto-threshold' }`, WHEN `resolvePolicy()` is called, THEN it returns `{ tier: 'human' }` (requiresReview takes precedence).

- **AC-7**: GIVEN a schedule with no `mergePolicy` field in its template and a workspace with `gitConfig.mergePolicy = { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } }`, WHEN the schedule fires and the created task's PR is evaluated, THEN `resolvePolicy()` returns the workspace `agent-review` policy (no regression in existing behaviour).

---

## Code surface

| Symbol | File | Purpose |
|---|---|---|
| `TaskScheduleTemplate` | `packages/shared/src/types.ts:669` | Add `mergePolicy?: MergePolicy` |
| `tasks.mergePolicy` | `packages/core/db/schema.ts:~846` | New nullable JSONB column |
| `resolvePolicy()` | `apps/web/src/lib/merge-policy.ts:58` | New step 2 in precedence chain |
| Schedule cron task insert | `apps/web/src/app/api/cron/schedules/route.ts:634` | Propagate `template.mergePolicy` |
| `applyPolicyConfigToMergePolicy()` | `apps/web/src/lib/workspace-policy.ts:211` | Unchanged — still fires post-resolvePolicy; only upgrades tier |
| Schedule save validation | `apps/web/src/app/api/workspaces/[id]/schedules/route.ts` | **DRIFT (found 2026-08-29): not implemented.** The route it named did not exist; schedule CRUD lives at the path shown, and it does not call `parseMergePolicy()` on `taskTemplate.mergePolicy`. An invalid policy on a schedule template is therefore accepted on write and only rejected (or silently ignored) at task-creation time. `parseMergePolicy()` is wired into `apps/web/src/app/api/missions/route.ts` and `apps/web/src/app/api/workspaces/[id]/config/route.ts` only. |

---

## Out of scope

- Direct `task.mergePolicy` field exposed in the task creation API (`POST /api/tasks`). This spec covers schedule-derived overrides only. Per-task ad-hoc overrides can be added in a follow-on spec.
- Changing which tier is the workspace default. The workspace `gitConfig.mergePolicy` is already configurable.
- UI for editing a schedule's mergePolicy. The API surface is sufficient for the first consumer (CHANGELOG schedule); a UI control can follow.
- Commit-direct-to-base-branch (no PR) mode. Auto-merge-on-CI-green is safer and preserves the audit trail.
