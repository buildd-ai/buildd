# Status Reconciliation: Derived-at-Read-Time State

**Status:** Accepted
**Related:**
- `apps/web/src/lib/mission-dependency.ts` — dependency gate logic
- `apps/web/src/lib/mission-helpers.ts` — `deriveHealth()`, `deriveDriveState()`
- `apps/web/src/lib/stale-workers.ts` — reaper and deliverable detection
- `packages/core/db/schema.ts` — all stored status fields
- `packages/shared/src/types.ts` — `GoalCriterion`, `GoalCriteriaState`, `InitiativeKPI`
- `docs/specs/missions.md`, `docs/specs/workers.md`
- `docs/design/mission-state-progress.md` — prior drive-state/health split design
- PR #971 — mission dependency gate (dependsOnMission introduced)
- PR #1174 — prLifecycleStatus + webhook integration
- PR #1298 — mission status split into DriveState + Health axes
- PR #1594 — stale-worker reaper false positive fix

---

## Problem

On 2026-08-11 a mission dependency gate reported BLOCKED while its upstream
mission was at 100% with all PRs merged. The only way to unstick it was to
manually clear `dependsOnMission` from the blocked mission. The issue: the
system's answer to "is this mission blocked?" was not derived from the state of
the world — it was derived from a timestamp (`dependencyMetAt`) that a webhook
was supposed to set and, in this case, did not.

This is the fourth time in six months the same shape of bug has appeared in an
unrelated subsystem:

| Incident | Stored verdict | Ground truth missed |
|---|---|---|
| Dependency gate stuck BLOCKED (2026-08-11) | `missions.dependencyMetAt IS NULL` | Upstream PRs already merged |
| Worker incorrectly stamped failed (PR #1594) | `tasks.status = 'failed'` | `workers.prUrl` showed delivered PR |
| Stale-worker reaper kills long-running agent (memory in KB, PR #830) | Worker treated as dead | Runner was legitimately busy |
| `goalCriteriaState` shows UNVERIFIED while artifacts demonstrably exist | Cached evaluation result | Artifact written after last evaluation |

The recurrence across unrelated subsystems is the signal. Each was fixed
individually. The underlying cause was not: **the system stores conclusions
about the state of the world rather than deriving them from it.**

This document is a spec for fixing that. It is not an implementation. Implementation
is gated on this doc being reviewed and merged.

---

## Current State: Inventory of Stored Status Fields

Every field below is either a conclusion cached at write time (the class of
problem we're addressing) or a user intent / audit record (legitimately stored).
The distinction matters: only cached conclusions are in scope.

### Task status

**`tasks.status`** (`packages/core/db/schema.ts:612`)
Free-text field, values in practice: `pending | assigned | in_progress | completed | failed | cancelled`.
Written by: claim route (→ `assigned`), worker progress (→ `in_progress`),
`resolveStaleTask` (→ `completed` or `failed`), explicit cancellation (→ `cancelled`),
task creation (→ `pending`).

Classification: **partially intent, partially conclusion**. `pending`,
`assigned`, and `in_progress` record intent ("this task is being worked on").
`completed` and `failed` are conclusions — they summarize worker outcomes. The
reaper's incorrect `failed` stamps (PR #1594) were a conclusion written from
incomplete evidence.

### Worker status

**`workers.status`** (`packages/core/db/schema.ts:694`)
Values: `idle | starting | running | waiting_input | completed | failed`.
Written by: runner progress updates and the stale-worker reaper.

**`workers.prLifecycleStatus`** (`packages/core/db/schema.ts:718`)
Values: `pr_open | ci_running | ci_failed | merged | conflict | closed | null`.
Written exclusively by GitHub webhook events (`apps/web/src/app/api/github/webhook/route.ts`).
This is a cached copy of external state — GitHub holds the ground truth.

**`workers.mergedAt`** (`packages/core/db/schema.ts:715`)
Timestamp stamped when `prLifecycleStatus` transitions to `merged` via webhook.
Used by: `checkDependsOnResolved()` (task-level dependency gate) and
`checkAndUnblockDependentMissions()` (mission-level gate).

Classification: all three are **cached external state** (GitHub PR reality).

### Mission status

**`missions.status`** (`packages/core/db/schema.ts:543`)
Values: `active | paused | completed | archived`.
Written by: user actions (pause/archive), organizer on `goalCriteria` passing,
mission completion logic.

Classification: **partly intent, partly conclusion**. `paused` and `archived`
are explicit human decisions. `completed` is a conclusion about task/criteria
state. The architecture note in PR #1596 establishes that `status=completed`
must only appear when the organizer has confirmed all goal criteria pass — it
should not be inferred from progress percentage alone.

**`missions.dependencyMetAt`** (`packages/core/db/schema.ts:557`)
Timestamp set by `checkAndUnblockDependentMissions()` when the upstream
mission satisfies its gate condition. This is a **one-way latch**: once set,
`isMissionBlocked()` returns `{ blocked: false }` unconditionally.

Classification: **pure cached conclusion**. This is the specific field that
caused the 2026-08-11 incident. When not set, the system treats the mission as
blocked regardless of actual upstream state.

**`missions.goalCriteria`** (jsonb, production schema)
The *definition* of completion criteria — not a status field. This is user
intent, correctly stored.

**`missions.goalCriteriaState`** (jsonb, production schema)
The last evaluation result of all goal criteria. Written by the evaluate
endpoint on-demand or by the organizer at heartbeat.

Classification: **cached conclusion**. Only as current as the last evaluation.
The UNVERIFIED-with-artifacts bug occurs when an artifact is created after the
last evaluation and the next evaluation hasn't fired yet.

**`missions.releasedAt`** (`packages/core/db/schema.ts:585`)
Atomic claim flag for mission-level release. Once set, duplicate release
triggers are suppressed.

Classification: **audit record** (when did the release fire). Correctly stored.

### Initiative status

**`initiatives.status`** (production schema)
Values: `active | paused | completed | archived`. Same classification as
`missions.status`: `paused`/`archived` are intent, `completed` is a
conclusion.

**`initiatives.progressCache`** (jsonb, production schema)
Denormalized rollup of `computeInitiativeProgress()` — total missions,
completed missions, and progress %. Refreshed on child-mission change.

Classification: **cached derived value** — an optimization, not a source of
truth. Correctly identified as a cache by the column name; the architecture
note in the memory for PR #1596 treats it as such.

**`initiatives.kpiState`** (jsonb, production schema)
Last KPI evaluation result. Same pattern as `goalCriteriaState`.

Classification: **cached conclusion** with the same UNVERIFIED-with-facts
failure mode as `goalCriteriaState`.

### Other status fields

**`missionNotes.status`** (`schema.ts:814`): `open | answered | dismissed`.
**Classification: user intent**. These transitions are human actions; correct to store.

**`secrets.healthStatus`** (`schema.ts:1093`): `healthy | degraded | revoked | unknown`.
**Classification: cached conclusion**. Set by spawn-time auth failures and
active verification. The `unknown` default is good staleness hygiene.

**`workspaces.configStatus`** (`schema.ts:497`): `unconfigured | admin_confirmed`.
**Classification: user intent**. Correct to store.

**`knowledgeIngestJobs.status`** (`schema.ts:1260`): `queued | running | done | error`.
**Classification: process state** — accurately reflects the lifecycle of a
background job. Correct to store; the idempotent unique index prevents the most
common corruption path.

**`deviceCodes.status`** (`schema.ts:1127`): `pending | approved | expired`.
**Classification: time-bounded state** — `expired` is computable from
`expiresAt`, but storing it is harmless and avoids scanning on every auth
check.

---

## The Worked Example: Dependency Gate Stuck on 2026-08-11

This section traces the full code path of the incident so the design has a
concrete problem to solve, not a hypothetical.

### Setup

Mission A (upstream) and Mission B (downstream) with
`B.dependsOnMissionId = A.id, B.gateCondition = 'merged'`.
All of A's tasks complete. All PRs for A's tasks are merged to `dev`.
A's organizer marks it at 100%. Someone manually sets `A.status = 'completed'`.

Mission B still shows BLOCKED. `B.dependencyMetAt IS NULL`.

### The decision path in `isMissionBlocked()`

`apps/web/src/lib/mission-dependency.ts:27`:

```
if (!mission.dependsOnMissionId) return { blocked: false };  // not applicable
if (mission.dependencyMetAt) return { blocked: false };       // null — not taken
// Load upstream:
upstream = SELECT id, title, status FROM missions WHERE id = B.dependsOnMissionId
// gateCondition = 'merged', so the 'completed' fallback is skipped:
if (mission.gateCondition === 'completed') {
  if (upstream.status === 'completed') return { blocked: false };  // WOULD save us
}
// We're in the 'merged' branch — only dependencyMetAt clears it:
return { blocked: true, reason: 'Waiting for mission A PRs to merge' };
```

The 'merged' gate has NO fallback that reads actual PR state. It is fully
gated on `dependencyMetAt`, which is only set by
`checkAndUnblockDependentMissions()` at `mission-dependency.ts:109`.

### Why `dependencyMetAt` was never set

`checkAndUnblockDependentMissions(upstreamMissionId, 'merged')` is called from
the GitHub PR-merge webhook path. If the webhook fires BEFORE the mission
dependency is set, or if the webhook misfires (retry exhausted, Vercel timeout,
network drop), the function never runs for this pair. No retry, no
reconciliation, no check at read time — the gate is stuck.

The system correctly has all the evidence needed to derive the unblocked state:
- `A.id` is known from `B.dependsOnMissionId`
- `A`'s tasks can be queried: `SELECT id FROM tasks WHERE missionId = A.id`
- Each task's workers can be checked: `SELECT mergedAt FROM workers WHERE taskId IN (...) AND prUrl IS NOT NULL`
- If all PRs have `mergedAt IS NOT NULL`, the gate condition is met

This query is entirely within the local database. No GitHub API call required.
But `isMissionBlocked()` never asks it for the 'merged' case.

### The fix available without a full reconciler

Add a live-derivation fallback to `isMissionBlocked()` for the 'merged' gate:
when `dependencyMetAt IS NULL` AND `gateCondition = 'merged'`, query whether all
upstream workers with PRs have `mergedAt IS NOT NULL`. If so, stamp
`dependencyMetAt` and return unblocked. This is a single additional query,
executed only on blocked missions, only at the decision point.

This is described further in the Proposal section.

---

## What the Prior Patches Partially Delivered

Understanding what has already been done is essential to avoid the common
anti-pattern of writing a spec that pretends the codebase is greenfield.

**PR #1298** (`docs/design/mission-state-progress.md`)
Split mission "status" into two orthogonal axes: `driveState` (AUTO /
MANUAL / QUIET_HOURS / SEATS_FULL / COMPLETE) and `health` (NOMINAL / BLOCKED
/ FAILING / STALLED). Both are computed at read time in
`apps/web/src/lib/mission-helpers.ts`. This is already the derivation model,
applied to presentation state. `driveState` and `health` have no stored columns;
they are always recomputed from mission row + task list.

This was the right architecture. The problem is that `deriveHealth()` at
`mission-helpers.ts:74` delegates BLOCKED detection to `mission.dependencyMetAt`
rather than querying upstream PR state:
```ts
if (mission.dependsOnMissionId && !mission.dependencyMetAt) return 'BLOCKED';
```

So the `Health` axis is derived at read time, but it inherits the flaw from the
underlying `dependencyMetAt` field.

**PR #1594** (stale-worker reaper fix)
Split the reaper's try-catch so artifact count errors don't shadow PR
deliverables (`getWorkerArtifactCount` error path no longer prevents
`checkWorkerDeliverables` from running). This is a narrower read-time
derivation fix: the reaper now gathers more ground truth before writing a
`failed` conclusion.

**PR #1431**
`checkDependsOnResolved` was updated to check `workers.mergedAt` in addition to
`tasks.status = 'completed'`. This is exactly the pattern we need for
`isMissionBlocked()`: the task-level gate already derives from `mergedAt` (a
locally-cached external fact); the mission-level gate does not.

**PR #1174**
Introduced `prLifecycleStatus` on workers, kept live by GitHub webhooks. This
established the pattern of caching external state locally so derivations don't
require live GitHub API calls. It is the right abstraction: the local DB is
the single read surface; GitHub is the authoritative write source that pushes
updates in.

---

## Proposal: Ground-Truth Sources and the Derived-vs-Stored Line

### Core thesis

**Stored:** facts about user intent, audit events, and external state (where the
external source pushes updates). **Derived:** conclusions about what those facts
imply (status, health, completeness, blockedness).

The distinction:
- `workers.mergedAt` is a fact (GitHub said this PR merged at T).
- "This mission is blocked" is a conclusion derived from `mergedAt` facts.
- Conclusions must never be permanently cached without a reconciliation path.

### Ground-truth sources

| Ground truth | Where it lives | How it arrives | Queryable without network? |
|---|---|---|---|
| PR merged | `workers.mergedAt` | GitHub webhook → DB | Yes |
| PR lifecycle | `workers.prLifecycleStatus` | GitHub webhook → DB | Yes |
| Task deliverables | `workers.prUrl`, `workers.prNumber`, artifact rows | Worker on complete | Yes |
| Artifact existence | `artifacts` table | Worker creates on complete | Yes |
| Worker liveness | `workerHeartbeats.lastHeartbeatAt` | Runner ping | Yes |
| Task open/closed | `tasks.status` | Workers + reaper | Yes |
| Mission goal criteria pass | `evaluateGoalCriteria()` over tasks/workers/artifacts | On-demand computation | Yes |
| Branch deleted | GitHub API | Webhook (best-effort) | No — requires API call |
| CI status | `workers.prLifecycleStatus` | GitHub webhook → DB | Yes |

All primary ground truths for the dependency gate and goalCriteria are
locally queryable. Branch-deleted checks are the only case that requires
a GitHub API call at evaluation time.

### The derived-vs-stored line (explicit)

**Correctly stored (not in scope):**
- `missions.status` as user-intent: `paused`, `archived` — these are human decisions
- `missionNotes.status` (`open/answered/dismissed`) — user action
- `workspaces.configStatus` — admin confirmation
- `workers.mergedAt` — external fact, push-updated
- `workers.prLifecycleStatus` — external fact, push-updated
- `tasks.status` when recording worker progress — this is live process state

**Cached conclusions that create stale-verdict risk (in scope):**
- `missions.dependencyMetAt` — a conclusion from upstream PR merge state
- `missions.goalCriteriaState` — a conclusion from task + worker + artifact state
- `initiatives.progressCache` — a conclusion from child mission states
- `initiatives.kpiState` — a conclusion from metric evaluations
- `tasks.status = 'failed'` as stamped by the reaper — a conclusion about worker deliverables
- `secrets.healthStatus` — a conclusion about auth success/failure recency

**Borderline (scope narrowed out):**
- `missions.status = 'completed'` — this should be a conclusion from goalCriteria,
  but it also represents user intent when set manually. The spec for how this
  field transitions is in PR #1298 and the goalCriteria design; this doc does
  not change that contract.

---

## Reconciler Design

Rather than a single monolithic reconciler, this section proposes three
targeted interventions, ordered by risk/value:

### Tier 1: Live-fallback for the dependency gate (highest value, lowest risk)

**What:** Extend `isMissionBlocked()` to derive blockedness from actual upstream
PR state when `dependencyMetAt IS NULL`.

**Mechanism:** In the 'merged' gate branch, before returning `{ blocked: true }`,
run a local query:

```sql
SELECT COUNT(*) AS open_prs
FROM workers w
JOIN tasks t ON w.task_id = t.id
WHERE t.mission_id = $upstreamMissionId
  AND w.pr_url IS NOT NULL
  AND w.merged_at IS NULL
```

If `open_prs = 0` (all PRs have merged), stamp `dependencyMetAt = now()` and
return `{ blocked: false }`. This self-heals without a reconciler and without
any change to the webhook path.

**When does this query run?** Only when a mission has a `dependsOnMissionId`
AND `dependencyMetAt IS NULL`. In practice that's a small set of missions —
only those currently in the blocked state.

**Cadence:** Per request, at `isMissionBlocked()` call sites:
`apps/web/src/lib/mission-run.ts:73` (mission heartbeat) and anywhere the
mission list queries health state.

**Idempotency:** Safe to run repeatedly. The `dependencyMetAt` update uses an
atomic `UPDATE ... WHERE dependencyMetAt IS NULL`.

**Staleness semantics:** If the upstream's `workers.mergedAt` is stale (webhook
hasn't fired), the mission stays BLOCKED until `mergedAt` is stamped. This is
correct — the system degrades to "appears blocked" rather than "incorrectly
unblocked." The improvement over current behaviour is that when `mergedAt` IS
populated, the gate self-clears without waiting for a webhook retry.

### Tier 2: Event-triggered re-evaluation of goalCriteria and kpiState (medium value, medium risk)

**What:** Re-evaluate `goalCriteriaState` and `kpiState` on write events that
could change the verdict, rather than only on-demand or at heartbeat.

**Trigger points:**
1. `POST /api/artifacts` (or worker completes with artifact) → re-evaluate
   `artifact_exists` criteria for the task's mission
2. PR-merge webhook (`workers.mergedAt` stamped) → re-evaluate `all_prs_merged`
   criteria for the mission
3. Task status → `completed` → re-evaluate `no_open_tasks` criteria

**Why not read-time derivation?** Because `evaluateGoalCriteria()` joins across
tasks, workers, and artifacts for a given mission. This is acceptable at the
evaluate endpoint (one mission at a time) and at heartbeat (one mission at a
time). It is NOT acceptable as an inline join on the missions list view, which
renders dozens of missions simultaneously. The list view should show cached
`goalCriteriaState.overall`, with the understanding that it's updated on write
events, not purely at read time.

**Staleness bound:** At most one write-event delay (typically seconds). The
current implementation's staleness is unbounded — evaluation only fires when
the organizer heartbeat runs or a human calls `evaluate`.

### Tier 3: Reconciliation loop for the dependency gate (low priority, backstop only)

**What:** A background cron (e.g., running every 15 minutes) that finds missions
where `dependsOnMissionId IS NOT NULL AND dependencyMetAt IS NULL`, checks
upstream PR state, and stamps `dependencyMetAt` for any that qualify.

**Why this is Tier 3, not Tier 1:** The live-fallback in `isMissionBlocked()`
(Tier 1) already fixes the read-time correctness problem. The reconciler is a
backstop for the webhook path — ensuring `dependencyMetAt` gets stamped even if
the live-fallback is removed or bypassed. It adds operational complexity (a new
cron, a new failure mode) for marginal benefit given Tier 1.

**When to build it:** If Tier 1 proves insufficient in practice, or if the team
wants the database state to be accurate independently of the read path.

---

## Staleness Semantics

Any consumer of a derived or cached status field must understand what it sees
when ground truth is unreachable.

**Proposed contract:**
1. A cached verdict (`goalCriteriaState`, `kpiState`) MUST include an
   `evaluatedAt` timestamp. UI must display "as of N minutes ago" when the
   gap is significant (> 10 minutes).
2. A `prLifecycleStatus` or `mergedAt` that is null means "unknown", not
   "not merged". UI must not render null as a negative verdict.
3. A mission with `dependencyMetAt IS NULL` but where the live-fallback
   query shows all PRs merged SHOULD self-heal at next read. It MUST NOT
   stay stuck across multiple read cycles.
4. The `secrets.healthStatus = 'unknown'` default is correct staleness hygiene
   — new rows don't assert a health verdict until verified.

**Degradation principle:** When ground truth is unreachable, the system should
degrade to "verdict unknown", not to "verdict negative." BLOCKED when actually
unblocked is worse than UNKNOWN, because it actively suppresses work.

---

## Case Against This Refactor

This section argues the opposing position honestly. A recommendation to scope
down is a valid outcome.

### Latency on list views

`deriveDriveState()` and `deriveHealth()` (PR #1298) already run on every
mission render. They take tasks and workers as input — the caller must JOIN them.
For a list of 50 missions, this is 50 queries (or one big JOIN) on every page
load. This is already paying the tax.

But adding goalCriteria derivation to the list path — joining tasks, workers,
and artifacts per mission to recompute `overall` — would multiply that cost.
The current cached `goalCriteriaState.overall` is a single column read. This is
a real latency regression. The event-trigger approach (Tier 2) avoids this by
keeping a fast-path cache while closing the staleness window.

### GitHub state requires network calls

The `all_prs_merged` criterion with `requireBranchDeleted` needs to check
branch existence via GitHub API. Read-time derivation of this criterion would
require a GitHub API call per mission per page load. This is not viable. The
current design correctly caches the webhook-delivered verdict; the problem is
that the cache doesn't self-refresh when the webhook fires out of order or
misses.

The right answer is NOT to make GitHub API calls at read time. It is to ensure
the webhook path is reliable and the local cache is self-healing.

### The reconciler is itself a system that can be wrong

A background reconciler that stamps `dependencyMetAt` based on a DB query has
its own failure modes:
- It queries at time T, finds all PRs merged, stamps `dependencyMetAt`
- A PR is reverted or force-pushed between T and when the downstream mission
  actually claims its first task
- The gate is now permanently open on a revert that should have blocked it

The webhook-delivered `mergedAt` has the same risk, but the reconciler amplifies
it by running on a cadence (15 minutes of gap) rather than on the event. For
high-correctness gates (mission dependencies where premature unblocking causes
wasted work), a reconciler is a weaker safety property than the webhook path.

### Some "cached" fields are correctly cached

`tasks.status = 'in_progress'` is not a stale verdict — it's a live assertion
that a worker is running. Replacing it with a derived value (check if any
worker is in a live state for this task) would add latency to the hot path
without improving correctness. The reaper handles the case where the assertion
goes stale. This is the right architecture for mutable process state.

### Honest scope assessment

A full "derive everything at read time" refactor is a high-risk rewrite with
diffuse latency impact and no clear stopping point. The bugs observed are in
three specific subsystems:
1. The mission dependency gate (`dependencyMetAt` not stamped on webhook miss)
2. Goal criteria / KPI evaluation (`goalCriteriaState` not refreshed on events)
3. Stale-worker reaper verdict (`tasks.status` stamped `failed` before
   deliverables are fully checked)

All three can be fixed with targeted changes. The architectural lesson is
important and worth stating (see Bug-class Assertion below), but it does not
require a unified reconciler framework to act on.

**Recommendation:** Build Tier 1 (live-fallback in `isMissionBlocked()`), build
Tier 2 (event-triggered re-evaluation), and treat the broader thesis as a
guiding principle for new status fields rather than a mandate to refactor
existing ones.

---

## Migration Plan

Sequencing matters because this touches status everywhere.

### Phase 1: Dependency gate live-fallback (proving ground)

**Target:** `apps/web/src/lib/mission-dependency.ts`
**Change:** Add live PR-state query in `isMissionBlocked()` for the 'merged' gate.
**Risk:** Low — additive query, only on blocked missions, self-healing stamp.
**Proof:** After landing, replay the 2026-08-11 incident scenario in a test
workspace. Confirm gate clears without manual intervention.
**Rollback:** Remove the live-derivation block; behaviour reverts to current
(webhook-only clearing).

No schema migration required. No UI change required.

### Phase 2: Event-triggered goalCriteria re-evaluation

**Target:** Evaluate endpoint + write paths for tasks/artifacts/PR merge.
**Change:** Call `evaluateGoalCriteria()` (or enqueue it) when:
- An artifact is created for a mission's task
- A worker's `mergedAt` is stamped by webhook
- A task status transitions to `completed` for a mission with `goalCriteria`

**Risk:** Medium — more evaluation calls, potential for rate limit hits. The
existing rate limit (6/hour on-demand per mission) does not apply to
event-triggered evaluations; a separate per-mission debounce (e.g., 30s
cooldown) prevents webhook fan-out storms.

**Schema change:** None. The existing `goalCriteriaState` column stores results.

### Phase 3: Staleness display (UI hygiene)

**Target:** Mission detail and list views that display `goalCriteriaState.overall`.
**Change:** Show `evaluatedAt` age when > 5 minutes. Replace "VERIFIED" label
with "VERIFIED (2m ago)" or similar.
**Risk:** Low — display-only change.

### Phase 4 (optional): Reconciler for dependency gate

Build only if Phase 1 proves insufficient. See Tier 3 above.

### Out of scope in all phases

- `tasks.status` refactor (process state, correctly stored)
- `missions.status` lifecycle refactor (partly intent, partly conclusion — complex enough to warrant its own design)
- `initiatives.progressCache` (already named as a cache, already refreshed on child-mission change)

---

## Bug-class Assertion

Which bugs become **structurally unrepresentable** under this model vs merely
less likely?

### Structurally unrepresentable (if Tier 1 ships)

**"Mission dependency gate stuck because webhook missed"** — Under the
live-fallback, `isMissionBlocked()` derives the answer from `workers.mergedAt`
at read time. A webhook miss delays `mergedAt` stamping, but once stamped the
gate clears on next read. The specific failure mode (stuck permanently because
`dependencyMetAt` never written) cannot recur if the live-fallback path
is exercised.

### Structurally unrepresentable (if Tier 2 ships)

**"goalCriteriaState shows UNVERIFIED while artifacts exist"** — If evaluation
triggers on artifact creation, the state is updated within seconds of the
artifact landing. The failure mode (bounded-staleness only) requires an artifact
to be created AND the evaluation to not fire for the same event; this requires
the event-trigger to fail, which is separately observable.

### Less likely but not unrepresentable

**"Stale-worker reaper stamps task failed while PR exists"** (PR #1594 class)
— Fixed in PR #1594 by reading `prUrl` before concluding. The fix is in the
reaper, not in the status field. The reaper could still get a wrong answer if
`prUrl` is not yet stamped when it runs (worker died before `create_pr` MCP
call). This is a temporal ordering problem, not a caching problem. Making
`tasks.status` derived at read time would not fix it; ensuring the reaper waits
for `prUrl` propagation would.

**"Worker heartbeat stale → reaper kills in-flight agent"** (memory: PR #828
class) — This is a liveness detection problem. The reaper observes
`lastHeartbeatAt` (a locally-cached fact). True derivation would require
probing the runner process directly. That's a network call, not a DB query.
The correct fix (as noted in the knowledge base) is for the runner to emit
liveness signals deterministically (timer-based, not agent-loop-based). This
is outside the scope of this design.

---

## Implementation Task Breakdown

The following tasks constitute the follow-on implementation mission. They are
ordered by dependency and risk.

**Phase 1 tasks:**

- **T1** — `isMissionBlocked()` live-fallback for 'merged' gate  
  File: `apps/web/src/lib/mission-dependency.ts`  
  Change: Add upstream PR query when `dependencyMetAt IS NULL AND gateCondition='merged'`. Stamp `dependencyMetAt` if all upstream PRs have `mergedAt`.  
  Tests: Add cases to `apps/web/src/lib/mission-dependency.test.ts` covering: gate clears when all PRs merged with no webhook, gate stays blocked when some PRs unmerged, completed-gate fallback still works.

- **T2** — Smoke test / regression  
  File: `apps/web/src/lib/mission-dependency.test.ts`  
  Verify: Replay 2026-08-11 scenario (upstream 100%, no `dependencyMetAt`, all workers have `mergedAt`). Confirm `{ blocked: false }`.

**Phase 2 tasks:**

- **T3** — Event-triggered goalCriteria re-evaluation: artifact create  
  Files: artifact creation path, `apps/web/src/app/api/missions/[id]/route.ts`  
  Change: After artifact create for a mission's task, call `evaluateGoalCriteria()` with 30s debounce per mission.

- **T4** — Event-triggered goalCriteria re-evaluation: PR merge webhook  
  Files: `apps/web/src/app/api/github/webhook/route.ts`  
  Change: After stamping `workers.mergedAt`, trigger goalCriteria re-evaluation for the task's mission (if any).

- **T5** — Event-triggered goalCriteria re-evaluation: task completed  
  Files: `apps/web/src/lib/task-dependencies.ts` (resolveCompletedTask)  
  Change: After resolving a task, evaluate the mission's goalCriteria if `goalCriteria` is set.

**Phase 3 tasks:**

- **T6** — Staleness display in mission detail  
  Files: Mission detail UI  
  Change: Show `evaluatedAt` age when `goalCriteriaState.evaluatedAt` is > 5 minutes ago.

**Deferrable (Phase 4):**

- **T7** — Background reconciler for dependency gate  
  Build only if T1 reveals edge cases where live-fallback is insufficient.

---

## Open Questions

1. **Debounce granularity for event-triggered evaluation.** 30s cooldown per
   mission is a guess. If a mission has 10 tasks completing in quick succession,
   that's 10 events with 9 no-ops. Is that acceptable, or should we use a 10s
   window? *Lean: 30s is safe to start; lower if heartbeat cadence shows gaps.*

2. **What does `all_prs_merged` with `requireBranchDeleted` do when branch
   state is unknown?** Current behaviour: UNVERIFIED. Proposed: keep UNVERIFIED;
   add a note that this criterion requires GitHub API access that isn't available
   at inline evaluation time. The event-triggered path (T4) can add a GitHub API
   call at webhook time and persist `branchDeleted` on the worker row.
   *Lean: persist `branchDeleted` on worker row, populated by webhook; avoid
   live GitHub calls in the hot evaluation path.*

3. **Should the dependency gate self-heal silently or emit an event?** When T1's
   live-fallback stamps `dependencyMetAt`, should it post a `mission:unblocked`
   event for UI real-time update? *Lean: yes, via existing Pusher
   `missions:updated` channel — no new event type needed.*

---

## Non-Goals

- Full read-time derivation of `tasks.status` and `workers.status`. These are
  process-state fields, not cached conclusions.
- Shared entity-reference UI component (PR link on escalation cards). Related
  but a presentation-layer concern; tracked separately.
- Metric KPI implementation (`type: 'metric'` in goalCriteria). Currently
  returns UNVERIFIED with a documented placeholder. Out of scope for this doc.
- `missions.status = 'completed'` lifecycle refactor. This is a larger
  conversation that touches the organizer, the evaluation flow, and human
  override semantics.
