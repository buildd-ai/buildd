---
title: Scheduled-task merge policy override
status: draft
owner: max
last_verified: 2026-09-19
summary: A task schedule MUST be able to declare a MergePolicy that overrides the workspace and mission default for every task it creates, acting as a floor that risk-class escalation can still raise.
domain: tasks
surfaces: [apps/web/src/lib/merge-policy.ts, apps/web/src/app/api/cron/schedules/route.ts, apps/web/src/lib/workspace-policy.ts, packages/shared/src/types.ts]
related: [db-migration-gates, external-cron-triggers, mission-task-lifecycle]
keywords: [merge_policy, auto-threshold, resolvepolicy, taskscheduletemplate, maxlines, changelog schedule]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "resolve-merge-policy"
    type: "symbol"
    name: "resolvePolicy"
    path: "apps/web/src/lib/merge-policy.ts"
    skip_until: "2026-12-15"
    skip_reason: "resolvePolicy has been exported since #1162 (2026-07-12), two months before this spec was drafted. Passing this assertion only proves the pre-existing export still exists, not that this spec's proposed task.mergePolicy step was added to it — see status callout."
  - id: "schedule-copies-merge-policy"
    type: "symbol_reachable"
    symbol: "mergePolicy"
    entry: "apps/web/src/app/api/cron/schedules/route.ts"
    as: "read"
  - id: "merge-policy-precedence-tests"
    type: "test_file"
    path: "apps/web/src/lib/merge-policy.test.ts"
    skip_until: "2026-12-15"
    skip_reason: "merge-policy.test.ts predates this spec and tests today's shipped precedence chain, not this spec's proposed task.mergePolicy step. File-existence passing says nothing about this capability — see status callout."
---

# Scheduled-task merge policy override

> **Status: `draft` — nothing in this spec is implemented.** It was carried as
> `active` while none of AC-1…AC-6 held, which is the one thing a spec may not
> be: `active` asserts what the system does today. Re-verified 2026-09-19
> against `dev` (originally verified 2026-09-04, re-verified 2026-09-15 and
> 2026-09-18 — nothing below has changed since the 2026-09-04 pass, only the
> cron insert's line number drifted, which the 2026-09-18 pass already fixed):
>
> - There is still no `tasks.merge_policy` column. `merge_policy` appears once
>   in `packages/core/db/schema.ts:807`, on `missions`.
> - `resolvePolicy` (`apps/web/src/lib/merge-policy.ts:124`) still has no
>   task-policy step, and its signature still cannot accept one — its `task`
>   parameter carries only `requiresReview`.
> - The schedule cron still does not propagate the template's merge policy —
>   zero occurrences in `apps/web/src/app/api/cron/schedules/route.ts` (the task
>   insert has drifted from line 634 to 728 to 754; `TaskScheduleTemplate`
>   (`packages/shared/src/types.ts:743`) still has no `mergePolicy` field).
> - `parseMergePolicy` is still wired only into
>   `apps/web/src/app/api/missions/route.ts` and
>   `apps/web/src/app/api/workspaces/[id]/config/route.ts`.
>
> The design is still wanted; `draft` is the honest home for it, and per
> `SPEC-FORMAT.md` a draft is where naming not-yet-existing symbols is correct.
>
> **Note on the two passing assertions** (`resolve-merge-policy`,
> `merge-policy-precedence-tests`): both are structural checks — that
> `resolvePolicy` is exported from `merge-policy.ts`, and that
> `merge-policy.test.ts` exists — not checks of this spec's capability. Both
> symbols have existed since `resolvePolicy`'s introduction in #1162
> (2026-07-12), long before this spec's own `mergePolicy`-on-`task` step was
> proposed, so their passing predates and is independent of this draft. A
> conformance run that reports them as "code ahead of doc" is a false
> positive: there is no code ahead here for this spec to catch up to.
>
> **Why this is now a `skip_until` suppression, not just prose:** the last two
> reconciliation passes (PR #2435, PR #2474) explained this false positive in
> prose only. `classifyAssertion` (`packages/core/spec-discrepancy-ledger.ts`)
> reads structural outcome and declared status alone — it has no way to see a
> status-callout paragraph — so both assertions kept classifying `code_ahead`
> against this doc's non-terminal status after every prose-only fix, and the
> ledger re-dispatched this exact reconciliation task each time the checker
> next ran (PR #2474 fixed the prose on 2026-09-18; the ledger re-checked at
> 2026-09-19T00:43 UTC, found the same `code_ahead` pair, and re-dispatched
> the task this PR is fixing). Both assertions now carry `skip_until:
> "2026-12-15"` with `skip_reason` per §6 of `spec-conformance.md` — the
> documented escape hatch for an assertion that legitimately passes but
> doesn't certify the doc's capability. That stops the repeat dispatch; it
> does not resolve the ledger rows, which stay open until the checker itself
> reconciles them per §9.
>
> **The open question this spec was blocked on has since been resolved —
> implementation is unblocked, but still not started.**
> `docs/design/mission-delivery-arc.md` is now `status: implemented`: Option A′
> (mission integration branches) shipped, answering *where the merge-policy
> tier applies* for mission-scoped delivery. That resolution does not implement
> this spec's capability — Option A′ is keyed on `missions.workingBranch` /
> `integrationBranchEnabled`, not on schedules or `tasks`, so a scheduled task
> outside a mission gets nothing from it. But it does change the shape this
> spec must fit into: Option A′ already occupies precedence-chain position 2
> (see "Precedence chain" below), so `task.mergePolicy` can no longer slot in
> at position 2 as originally written — it would need to sit above Option A′,
> not replace it.
>
> `docs/design/mission-delivery-arc.md` §B8 still asks the open question
> directly: implement `tasks.mergePolicy` per this spec, or retire the spec to
> `superseded`. Neither has happened as of this reconciliation pass — that
> decision is left to a human rather than made unilaterally here. Promote this
> back to `active` in the PR that implements it, with `verified_by` populated.

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

`apps/web/src/app/api/cron/schedules/route.ts:754` — the `db.insert(tasks)`
call MUST propagate `template.mergePolicy` when present:

```ts
...(template.mergePolicy ? { mergePolicy: template.mergePolicy } : {}),
```

The value is written as-is (already validated at schedule-save time). No
additional validation at creation time.

---

## Precedence chain (updated)

The chain below is this spec's **proposal** — none of it is built (see status
callout above). It no longer matches the chain `resolvePolicy()` actually runs
today, because Option A′ (`docs/design/mission-delivery-arc.md`) shipped after
this spec was drafted and took the position-2 slot this spec wanted:

**Shipped, as of 2026-09-15** (`apps/web/src/lib/merge-policy.ts:124-149`):

```
1. task.requiresReview = true                        →  { tier: 'human' }
2. PR based on the mission integration branch (A′)   →  { tier: 'auto-threshold', threshold: carried through }
3. mission.mergePolicy
4. mission.requiresReview = true                     →  { tier: 'human' }
5. workspace.gitConfig.mergePolicy
6. DEFAULT_MERGE_POLICY  ({ tier: 'auto-threshold', threshold: { maxLines: 800 } })
```

**Proposed by this spec**, renumbered to slot in above Option A′ instead of at
the position originally written:

```
1. task.requiresReview = true  →  { tier: 'human' }      (explicit human gate)
2. task.mergePolicy            →  parsed value             ← NEW (this spec)
3. PR based on the mission integration branch (A′)
4. mission.mergePolicy
5. mission.requiresReview = true  →  { tier: 'human' }
6. workspace.gitConfig.mergePolicy
7. DEFAULT_MERGE_POLICY
```

`resolvePolicy()`'s actual signature has also already diverged from what this
spec proposed — it takes an additional `pr` argument for the Option A′ check,
and `mission` carries `workingBranch` / `integrationBranchEnabled` alongside
`mergePolicy` / `requiresReview`. What this spec still needs to add is a
`mergePolicy` field on `task`, checked immediately after the
`task.requiresReview` guard and before the Option A′ check:

```ts
task?: { requiresReview?: boolean; mergePolicy?: MergePolicy | null } | null,
// ...
if (task?.requiresReview) return { tier: 'human' };
if (task?.mergePolicy) return parseMergePolicyRead(task.mergePolicy);  // NEW
// (Option A′ check, unchanged, follows)
```

All callers of `resolvePolicy()` already pass the `task` object from a DB
query — adding `mergePolicy` to the selected columns is the only call-site
change needed.

---

## Risk-class interaction

`applyPolicyConfigToMergePolicy()` in
`apps/web/src/lib/workspace-policy.ts:452` is called **after** `resolvePolicy()`
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

`POST /api/workspaces/[id]/schedules` and
`PATCH /api/workspaces/[id]/schedules/[scheduleId]` MUST validate
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

- **AC-5**: GIVEN a schedule with `taskTemplate.mergePolicy = { tier: 'invalid-tier' }`, WHEN `POST /api/workspaces/[id]/schedules` is called, THEN the server returns HTTP 400 with an error identifying `mergePolicy.tier`.

- **AC-6**: GIVEN a task with both `requiresReview = true` and `mergePolicy = { tier: 'auto-threshold' }`, WHEN `resolvePolicy()` is called, THEN it returns `{ tier: 'human' }` (requiresReview takes precedence).

- **AC-7**: GIVEN a schedule with no `mergePolicy` field in its template and a workspace with `gitConfig.mergePolicy = { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } }`, WHEN the schedule fires and the created task's PR is evaluated, THEN `resolvePolicy()` returns the workspace `agent-review` policy (no regression in existing behaviour).

---

## Code surface

| Symbol | File | Purpose |
|---|---|---|
| `TaskScheduleTemplate` | `packages/shared/src/types.ts:743` | Add `mergePolicy?: MergePolicy` |
| `tasks.mergePolicy` | `packages/core/db/schema.ts` | New nullable JSONB column — does not exist yet; `missions.mergePolicy` (`schema.ts:807`) is the nearest existing analog |
| `resolvePolicy()` | `apps/web/src/lib/merge-policy.ts:124` | New step above Option A′ in precedence chain (not position 2 — that slot is now Option A′; see "Precedence chain" above) |
| Schedule cron task insert | `apps/web/src/app/api/cron/schedules/route.ts:754` | Propagate `template.mergePolicy` |
| `applyPolicyConfigToMergePolicy()` | `apps/web/src/lib/workspace-policy.ts:452` | Unchanged — still fires post-resolvePolicy; only upgrades tier |
| Schedule save validation | `apps/web/src/app/api/workspaces/[id]/schedules/route.ts` | **DRIFT (found 2026-08-29): not implemented.** The route it named did not exist; schedule CRUD lives at the path shown, and it does not call `parseMergePolicy()` on `taskTemplate.mergePolicy`. An invalid policy on a schedule template is therefore accepted on write and only rejected (or silently ignored) at task-creation time. `parseMergePolicy()` is wired into `apps/web/src/app/api/missions/route.ts` and `apps/web/src/app/api/workspaces/[id]/config/route.ts` only. |

---

## Out of scope

- Direct `task.mergePolicy` field exposed in the task creation API (`POST /api/tasks`). This spec covers schedule-derived overrides only. Per-task ad-hoc overrides can be added in a follow-on spec.
- Changing which tier is the workspace default. The workspace `gitConfig.mergePolicy` is already configurable.
- UI for editing a schedule's mergePolicy. The API surface is sufficient for the first consumer (CHANGELOG schedule); a UI control can follow.
- Commit-direct-to-base-branch (no PR) mode. Auto-merge-on-CI-green is safer and preserves the audit trail.
