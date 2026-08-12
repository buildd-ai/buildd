# Status Reconciliation: Derive State from Ground Truth

**Status:** Accepted
**Related:**
- `apps/web/src/lib/mission-dependency.ts` — dependency gate implementation
- `apps/web/src/lib/mission-helpers.ts` — mission health / drive-state derivation
- `apps/web/src/lib/stale-workers.ts` — worker reaper (verdict-stamping path)
- `packages/core/db/schema.ts` — all status/verdict columns
- `packages/shared/src/types.ts` — `GoalCriterion`, `GoalCriteriaState`, `InitiativeKPI`
- `docs/specs/missions.md`, `docs/specs/workers.md`

---

## Problem

buildd stores judgments about the world instead of deriving them from it. A verdict gets computed at write time, cached in a column, and nothing ever revisits it when the underlying reality changes.

**Observed instances, all the same shape:**

| Symptom | Stored verdict | What reality said |
|---------|---------------|-------------------|
| Mission dependency gate showed BLOCKED while upstream was 100% merged (2026-08-11) | `missions.dependencyMetAt IS NULL` — webhook never fired | All upstream workers had `mergedAt` set |
| Stale-worker reaper fails task with prUrl already set | `tasks.status = 'failed'` | Worker had a PR open and commits pushed |
| Completed tasks stamped failed (recurring) | `tasks.status = 'failed'` | Worker delivered before dying |
| `goalCriteriaState.overall = 'UNVERIFIED'` when artifacts demonstrably exist | Cached evaluation result | `artifacts` table had matching rows |
| Mission stuck BLOCKED after upstream completed | `dependencyMetAt IS NULL` (for `gateCondition='merged'`) | No webhook fallback for merged-gate |

Each was previously fixed as an individual bug. The recurrence across unrelated subsystems is the signal: **the bug is architectural, not local.**

---

## Current State

### Status/verdict columns that write conclusions

The following columns are **stored conclusions** — derived once and never re-checked:

**missions table**
- `dependencyMetAt TIMESTAMPTZ` — set by `checkAndUnblockDependentMissions()` via webhook or explicit API call. Null means blocked. But the only trigger is the GitHub PR-merge webhook; if the webhook misses, the gate sticks forever.
- `goalCriteriaState JSONB` (`GoalCriteriaState`) — last evaluation result including `overall: 'pass' | 'fail' | 'UNVERIFIED'`. Evaluated on demand or by organizer; never refreshed on artifact creation.

**initiatives table**
- `kpiState JSONB` (`InitiativeKPIState`) — cached KPI evaluation, same problem as `goalCriteriaState`.
- `progressCache JSONB` — denormalized rollup of child-mission progress, refreshed on child-mission changes. Can lag under concurrent writes.

**workers table**
- `status TEXT` — the reaper (`stale-workers.ts`) mutates this to `'failed'` based on heartbeat age. This is a time-based heuristic judgment that can misfire when a worker delivered but then went quiet.
- `prLifecycleStatus TEXT` — updated by GitHub webhook. This is NOT a verdict; it's an event-sourced fact. ✓ Correct pattern.
- `mergedAt TIMESTAMPTZ` — set by webhook. Also an event-sourced fact. ✓ Correct pattern.

**tasks table**
- `status TEXT` — set by reaper, runner, and orchestrator. Some of these are legitimate (runner completing a task = fact), others are reaper heuristics (= verdict).

### What is already correctly derived

These are **pure functions of observable data** computed at read time — the right pattern:

| Function | File | What it derives |
|----------|------|----------------|
| `deriveHealth()` | `apps/web/src/lib/mission-helpers.ts:60` | `NOMINAL \| BLOCKED \| FAILING \| STALLED` from tasks + workers |
| `deriveDriveState()` | `apps/web/src/lib/mission-helpers.ts:13` | `AUTO \| MANUAL \| QUIET_HOURS \| SEATS_FULL \| COMPLETE` from mission fields |
| `deriveMissionDisplayState()` | `apps/web/src/lib/mission-helpers.ts` | Collapsed display chip |
| `computeMissionProgress()` | `packages/core/mission-helpers.ts:68` | Progress % + segments from tasks + workers |
| `isDeliverableTask()` | `packages/core/mission-helpers.ts:21` | Inclusion predicate, pure |
| `deriveDisplayStatus()` | `apps/web/src/lib/task-timestamps.ts` | Task chip, pure |
| `isMissionBlocked()` | `apps/web/src/lib/mission-dependency.ts:27` | Blocked? — BUT has the merged-gate gap (see §1) |

The display layer is largely correct. The gap is at the data layer: stored verdicts being treated as current facts.

---

## Proposal

**Crux:** A verdict field is only valid at the instant it was written. The system must either re-derive it on every read (cheap, synchronous) or store it with an explicit staleness marker so consumers know they're looking at a snapshot, not truth. **No verdict field may be silently stale.**

### 1. Inventory of every stored status/verdict field

| Entity | Column | Current writer | Ground truth source | Action |
|--------|--------|----------------|---------------------|--------|
| `missions` | `status` | Organizer, user | User intent / organizer lifecycle | **Keep stored** — this is user intent, not a derived conclusion |
| `missions` | `dependencyMetAt` | Webhook, `checkAndUnblockDependentMissions()` | Upstream mission: tasks' `mergedAt` (for `gateCondition='merged'`), or `missions.status='completed'` | **Replace with live query** — eliminate stored gate, derive at read time |
| `missions` | `goalCriteriaState` | `evaluateGoalCriteria()` on demand | Artifacts table, task statuses, worker PR state | **Add staleness TTL** — keep cached but surface staleness, never show stale as current |
| `missions` | `primaryPrUrl / primaryPrNumber` | Worker completion | Worker `prUrl` / `prNumber` fields | **Keep stored** — convenience denorm, not a verdict |
| `missions` | `releasedAt` | Release lock claim | Atomic claim (correct pattern) | **Keep stored** — idempotency lock, not a verdict |
| `initiatives` | `status` | Organizer, user | User lifecycle intent | **Keep stored** — user intent |
| `initiatives` | `kpiState` | `evaluateKPIs()` on demand | External metrics, artifacts | **Add staleness TTL** — same pattern as goalCriteriaState |
| `initiatives` | `progressCache` | Child-mission change hooks | Child-mission `tasks` + `workers` aggregation | **Keep stored but validate** — refreshed eagerly; add a `progressCacheUpdatedAt` column |
| `workers` | `status` | Runner (heartbeat), reaper | Heartbeat recency, PR/commit delivery | **Split reaper path** — runner-set status is a fact; reaper-set `'failed'` is a verdict (see §4) |
| `workers` | `prLifecycleStatus` | GitHub webhook | GitHub PR state | **Keep** — event-sourced fact ✓ |
| `workers` | `mergedAt` | GitHub webhook | GitHub merge event | **Keep** — event-sourced fact ✓ |
| `tasks` | `status` | Worker, reaper, orchestrator | Worker terminal result, reaper heuristics | **Reaper path only** — worker-set terminal statuses are facts; reaper stamps are verdicts |
| `secrets` | `healthStatus` | Auth failure observers | Last auth attempt outcome | **Keep stored** — health score, updated by fresh observations |

### 2. Ground-truth sources

| Observable | Authoritative source | Query type |
|------------|---------------------|-----------|
| Mission PRs all merged | `workers.mergedAt IS NOT NULL` for all workers with `prUrl` on deliverable tasks | Synchronous DB query (cheap) |
| Mission tasks all completed | `tasks.status IN ('completed', 'cancelled')` for all deliverable tasks | Synchronous DB query (cheap) |
| Upstream mission status | `SELECT status FROM missions WHERE id = $dependsOnMissionId` | Synchronous DB query (cheap) |
| Artifact existence | `SELECT 1 FROM artifacts WHERE missionId=$id AND (key=$key OR type=$type)` | Synchronous DB query (cheap) |
| Worker liveness | `workerHeartbeats.lastHeartbeatAt > now() - 150m` for the runner account | Synchronous DB query (cheap) |
| Worker PR state | `workers.prLifecycleStatus` (webhook-set) | Already event-sourced ✓ |
| CI status | GitHub Checks API via `prLifecycleStatus = 'ci_failed' | 'ci_running'` | Webhook-pushed, polled on gap |
| Initiative KPIs | External metrics or DB queries (metric type dependent) | Async, expensive — must be cached |
| Command criterion | Shell execution via spawned worker task | Expensive — never re-run without user intent |
| goalCriteria `all_prs_merged` | Same as "Mission PRs all merged" above | Cheap |
| goalCriteria `no_open_tasks` | `tasks.status NOT IN ('completed', 'failed', 'cancelled')` count | Cheap |
| goalCriteria `artifact_exists` | Artifacts table query | Cheap |
| goalCriteria `metric` | External (same as Initiative KPIs) | Expensive |
| goalCriteria `command` | Shell execution | Expensive |

**Which are polled vs pushed:**
- **Pushed** (webhook): `workers.mergedAt`, `workers.prLifecycleStatus`, `missions.status` (user action), CI state
- **Queryable on demand** (cheap, synchronous): dependency gate, task statuses, artifact existence, worker liveness
- **Expensive / async**: KPI metrics, command criteria — require explicit evaluation trigger

### 3. Derived vs stored: the explicit line

**Legitimate to persist (source-of-record):**
- Timestamps of events that happened (`mergedAt`, `completedAt`, task/worker `createdAt`)
- User intent (`missions.status`, `missions.orchestrationMode`, `missions.goalCriteria` definitions)
- Human decisions (`missions.requiresReview`, `missions.gateCondition`)
- Audit history (worker milestones, instruction history, task result snapshot)
- External event facts pushed by webhooks (`workers.prLifecycleStatus`, `workers.mergedAt`)
- Idempotency locks (`missions.releasedAt`)
- Expensive-to-compute cached values WITH an explicit staleness timestamp

**Must not persist as if current:**
- "Is this mission blocked?" — must derive at read time from upstream state
- "Are all PRs merged?" — must derive from `workers.mergedAt` + task scope
- "Is this worker dead?" — must derive from `lastHeartbeatAt` recency + delivery check
- Any field whose value silently disagrees with facts it purports to summarize

**Expensive caches (permitted with staleness):**
- `goalCriteriaState` — add `evaluatedAt` (already present in schema), enforce that API responses always include it
- `kpiState` — same
- `initiatives.progressCache` — add `progressCacheUpdatedAt` column

The contract: **every derived value served to a client must carry its derivation timestamp**. UI shows "last checked 3h ago" not a silent stale verdict.

### 4. Reconciler design

**Where the reconciliation loop runs:**

There is no single reconciler daemon. Instead, reconciliation happens at three tiers:

**Tier 1 — Read-time derivation (synchronous, always fresh):**
Functions that compute from DB facts without storing anything. These never need reconciliation.

Add to this tier:
- `isMissionBlocked()` for `merged` gate — replace `dependencyMetAt` check with a direct query of upstream workers' `mergedAt`. See §6 Migration step 1.

**Tier 2 — Cron-triggered sweep (periodic, catches what webhooks missed):**
The existing cron at `GET /api/cron/schedules` runs every ~1 min and already calls `checkAndUnblockDependentMissions()`. The fix is to make this idempotent and to close the `merged`-gate gap:
- On each sweep, for missions with `dependsOnMissionId` and `dependencyMetAt IS NULL`, compute live whether the gate is met
- If met, write `dependencyMetAt = now()` as a **cache stamp** (not a primary truth; the live query is primary)

**Tier 3 — Background task (expensive evaluations, explicit trigger):**
`goalCriteria` with `command` or `metric` types cannot be evaluated cheaply. These run via spawned worker tasks (current design, `evaluateGoalCriteria()`). The fix is to ensure every evaluation writes `goalCriteriaState.evaluatedAt` and that the API response always includes it.

**Cadence summary:**

| Check | Tier | Cadence | Notes |
|-------|------|---------|-------|
| Dependency gate | 1 (read-time) | Every render | Cheap DB query |
| Worker liveness | 1 (read-time) | Every render | Heartbeat recency |
| Task/PR completion | 1 (read-time) | Every render | Count from tasks/workers |
| goalCriteria (cheap types) | 1 or 2 | Read-time or cron | `all_prs_merged`, `no_open_tasks`, `artifact_exists` |
| goalCriteria (command/metric) | 3 | Manual or organizer-triggered | Write `evaluatedAt` always |
| Initiative KPI | 3 | Manual or organizer-triggered | Write `evaluatedAt` always |

**Cost floor for list views:**

List views render dozens of mission rows. The acceptable pattern:
- Compute `isMissionBlocked()` as a JOIN (not N+1 queries) — one query for all missions and their upstream status
- `deriveHealth()` already requires pre-fetching tasks + workers; this is correct
- Do NOT call GitHub API per-row; use pre-fetched `workers.prLifecycleStatus`

### 5. Staleness semantics

**Rule: Never silently present a stale verdict as current.**

For each tier:

**Tier 1 (read-time):** Never stale. Ground truth is queried on demand.

**Tier 2 (cron):** Cron runs every ~1 min. Gate stamps from cron are at most 1 minute stale. Acceptable — but the UI must not show `dependencyMetAt` as "cleared at X" in a way that implies real-time truth.

**Tier 3 (expensive caches):** Always surface `evaluatedAt` to the client.
- If `evaluatedAt` is older than a configurable threshold (default: 24h for criteria, 4h for KPIs), the API response includes `stale: true`
- UI renders `"Last checked: 3h ago"` alongside the verdict, with a re-evaluate button
- **Never** show a stale `UNVERIFIED` or `fail` as current — degrade visibly: `"UNVERIFIED (not checked recently)"`

**When ground truth is unreachable (GitHub down, runner offline):**
- Dependency gate: DB query always available (no GitHub call needed). No degradation path needed.
- `goalCriteriaState`: return last cached state with `stale: true` flag. Do not re-evaluate.
- `kpiState`: same.
- Worker liveness: if heartbeat table is unavailable, treat all workers as unknown (render as ⚠️, not "running").

**The staleness contract in the API response shape:**
```ts
// Every cached verdict must include these fields:
interface CachedVerdict<T> {
  value: T;
  evaluatedAt: string;     // ISO timestamp of last evaluation
  stale: boolean;          // true when age > threshold
  thresholdSeconds: number; // what threshold was applied
}
```

### 6. Migration sequence

**Principle: smallest surface first, incremental, no big-bang cutover.**

**Step 1 — Dependency gate live query (proving ground):**
- Surface area: `isMissionBlocked()` in `apps/web/src/lib/mission-dependency.ts`
- Change: for `gateCondition = 'merged'`, add a fallback that queries upstream mission's workers for `mergedAt IS NOT NULL` on all deliverable tasks. If all merged, return `blocked: false` regardless of `dependencyMetAt`.
- `dependencyMetAt` column is kept but becomes a **performance cache** (can be pre-computed by cron), not primary truth. The live query always overrides it.
- Why this first: smallest SQL join, already known broken, clearest ground truth, zero risk to other subsystems.

**Step 2 — Worker liveness (reaper split):**
- Surface area: `stale-workers.ts`, `resolveStaleTask()`
- Change: extract `isWorkerLikelyDead(worker, heartbeatAgeMs)` as a pure function that returns a reason + confidence level. Only promote to `failed` when confidence is high AND `checkWorkerDeliverables()` returns `false`.
- Add a DB index on `(taskId, status)` for workers to make the "how many failed workers?" query fast.
- The existing `MAX_WORKER_RETRIES = 3` guard is correct; the gap is the deliverables check being short-circuited by a shared try-catch (already fixed in PR #1594; verify this holds).

**Step 3 — goalCriteria cheap types at read-time:**
- Surface area: `apps/web/src/lib/goal-criteria-evaluator.ts` (or wherever `evaluateGoalCriteria()` lives)
- Change: for `all_prs_merged`, `no_open_tasks`, `artifact_exists` criterion types, compute the verdict synchronously in the `GET /api/missions/[id]` response without touching `goalCriteriaState`. Surface this as a `liveVerdict` field alongside the cached `goalCriteriaState`.
- This means the mission detail view always shows a live answer for cheap criteria, and the cached state is clearly labeled as an evaluation snapshot.

**Step 4 — Staleness timestamps on all cached verdicts:**
- Surface area: `GoalCriteriaState` + `InitiativeKPIState` API serialization
- Change: every API response that includes `goalCriteriaState` or `kpiState` adds a `stale: boolean` computed from `evaluatedAt` age vs. threshold.
- UI renders a staleness banner when `stale: true`.
- Database: add `goalCriteriaEvaluatedAt TIMESTAMPTZ` column to missions if `GoalCriteriaState.evaluatedAt` isn't already surfaced clearly (verify in migration).

**Step 5 — Initiative progress cache validation:**
- Surface area: `initiatives.progressCache` + `loadInitiativeList()`
- Change: add `progressCacheUpdatedAt TIMESTAMPTZ` column. If `progressCacheUpdatedAt < missions.updatedAt` for any child mission, mark progress as potentially stale and trigger a background refresh.
- Do NOT show stale progress numbers as current in list views.

**Step 6 — Comprehensive audit and dead-code removal:**
- Remove `checkAndUnblockDependentMissions()` once Step 1's live query is proven stable (keep the webhook handler, remove the stored-verdict write path, or reduce it to a performance hint).
- Audit all `WHERE status = 'failed'` writes to confirm they are event-sourced, not heuristic.

**Sequence rationale:** Steps 1 → 2 → 3 address the known broken cases. Steps 4 → 5 add the staleness API contract. Step 6 cleans up. Each step is independently deployable with no dependency on the others.

### 7. Bug-class assertion

**Bugs that become STRUCTURALLY UNREPRESENTABLE under this model:**

1. **Dependency gate stuck BLOCKED when upstream is merged** — eliminated. `isMissionBlocked()` for `merged` gate will query `workers.mergedAt` directly. There is no stored field that could disagree with the facts.

2. **Mission stuck BLOCKED after upstream completes (completed gate)** — already partially addressed by the `upstream.status === 'completed'` fallback in `isMissionBlocked()`. Step 1 makes this complete.

3. **Worker prematurely failed when PR exists** — addressed by Step 2 separating the deliverables check from the retry-count path. A worker with a PR and commits cannot be stamped `failed`.

**Bugs that become LESS LIKELY but not structurally impossible:**

4. **goalCriteria returns UNVERIFIED when artifacts exist** — the `artifact_exists` criterion computed at read time (Step 3) eliminates this for that type. For `command` and `metric` types, the result is still cached; if the cache is never updated (e.g., autoVerify=false and no manual trigger), UNVERIFIED can still linger. Mitigation: Step 4 surfaces staleness so the UI never silently shows UNVERIFIED as authoritative.

5. **Completed tasks incorrectly stamped failed** — Step 2 reduces the probability. However, the task status column remains a stored verdict (the runner writes it, the reaper reads it). A race between runner completion and reaper sweep is still theoretically possible; the existing `PATCH /api/workers/[id]` completion path needs an idempotent `SET status='completed' WHERE status != 'completed'` guard. This is a narrower fix, not a structural elimination.

6. **Initiative KPI state stale** — Step 4 makes staleness visible. The stale value itself can still be wrong if the underlying metric changed; the structural fix would require KPIs to be queryable synchronously, which is out of scope (they depend on external data).

**What this does NOT fix:**
- Human decisions encoded as status (e.g., manually setting `missions.status = 'paused'`). These are correct to store — they ARE the ground truth.
- Race conditions in distributed concurrent workers that complete simultaneously. The fix there is atomic idempotent writes, not reconciliation.
- Bugs in the ground-truth sources themselves (e.g., GitHub webhook delivering wrong merge data). The reconciliation model assumes the ground truth is correct; it cannot fix lies in the oracle.

---

## Open questions

**Q1: Should `dependencyMetAt` be dropped or kept as a performance cache?**

Lean: keep as a **performance hint** that the cron writes, but never use it as the primary truth in `isMissionBlocked()`. The live query is always authoritative. Dropping the column is an unnecessary migration risk given it also serves as a "when did the gate open?" audit timestamp.

**Q2: Should the staleness threshold be configurable per-team or global?**

Lean: global constant in `apps/web/src/lib/criteria-evaluator.ts` (24h for goalCriteria, 4h for KPIs). Per-team configurability is future work — don't build it now.

**Q3: Should cheap goalCriteria types be computed at read-time (Tier 1) or only at evaluation time (Tier 3)?**

Lean: Tier 1 for `all_prs_merged`, `no_open_tasks`, `artifact_exists`. These are cheap DB queries that have the same cost as loading the mission detail anyway. The cached `goalCriteriaState` remains for `command` and `metric` types where evaluation is expensive.

---

## Non-goals

- The shared entity-reference component (one renderer for "a PR", one for "a task", used on every surface). Real and related, but a presentation-layer concern. Track separately.
- Real-time streaming of status changes (WebSocket / Pusher per-field). Current Pusher events are sufficient; this design does not add new event types.
- Replacing the existing cron architecture with a standalone reconciler daemon. Vercel serverless constraints make a daemon impractical; cron + read-time derivation is the correct model for this deployment.
- Fixing bugs in the external oracles (GitHub API, Vercel). Out of scope.
- Any implementation work — this doc scopes the follow-on implementation mission.
