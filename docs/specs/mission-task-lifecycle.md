---
title: Mission & Task Lifecycle
status: active
owner: max
last_verified: 2026-09-05
summary: The coordination layer MUST allow only documented task/worker/mission transitions, derive mission health from live tasks, name every claim gate, and refuse completion without passing criteria or with an unmerged PR.
domain: missions
surfaces: [apps/web/src/lib/mission-completion.ts, apps/web/src/app/api/workers/claim/route.ts, packages/core/mission-helpers.ts, apps/web/src/lib/condensed-timeline.ts]
related: [subject-anchor-liveness, external-cron-triggers, release-flow]
keywords: [gatereason, cancompletemission, derivemissionhealth, goalcriteria, dependson, activehours, awaitingmerge, isWaitingOnYou, workingbranch, integration branch, primaryprnumber]
supersedes: []
---
# Mission and Task Lifecycle

**Capability statement**: The buildd coordination layer MUST enforce the defined
state machines for both tasks and missions, allowing only documented transitions,
deriving mission health from live task state (never storing it), and unblocking
downstream DAG tasks when a task reaches a terminal state.

---

## Task State Machine

**States**: `pending` → `assigned` | `claimed` → `in_progress` → `review` →
`completed` | `failed`

The authoritative status string is `tasks.status`. The schema uses `text` (not
an enum) to allow extension without migrations.

| Status | Meaning |
|--------|---------|
| `pending` | Available for a runner to claim. |
| `assigned` | Reserved for a specific runner (not yet started). |
| `claimed` | Claimed optimistically; worker row being created. |
| `in_progress` | Worker has started (runner transitions via PATCH). |
| `running` | Worker is actively running (worker status, not task). |
| `review` | Output submitted; awaiting human review. |
| `completed` | Terminal: deliverable produced (or promoted from stale worker with deliverables). |
| `failed` | Terminal: all retry attempts exhausted or permanent error. |

**Invariants**:
- A task with `dependsOn` set MUST remain `pending` (non-claimable) until all
  listed task IDs are `completed`.
- `claimedBy` MUST be set atomically with `status = 'claimed'` using an
  `UPDATE … WHERE status = 'pending'` optimistic lock.
- A task with an active worker (status in `running`, `starting`, `waiting_input`,
  `idle`) MUST NOT be reset to `pending` while that worker is alive.
- `outputRequirement = 'pr_required'` MUST block `complete_task` unless
  `workers.prUrl` is set.
- `outputRequirement = 'auto'` (the default) MUST block `complete_task` when the
  worker has committed at least one commit and has neither a tracked/detected PR
  nor a deliverable artifact — a commit with no PR and no artifact is a stranded
  change that a bare "completed" status would misrepresent as landed. A task
  with zero commits (e.g. research/recon) is unaffected. GitHub auto-detection
  by branch name (not worker id) means a branch whose PR was opened by an
  earlier worker row — e.g. a CI/conflict retry continuing on the same branch —
  still satisfies the gate.
- A task transitions to `failed` permanently after `MAX_WORKER_RETRIES = 3`
  failed workers with no deliverables.
- A task with `roleSlug = null` is claimable by any runner with access to the
  workspace — this is the normal case for dashboard-created tasks. Routing via
  `roleSlug` is primarily used by MCP `create_task`, orchestrator agents, and
  schedules. `context.skillSlugs` (JSON field) carries advisory skill hints to
  the executing agent but does NOT restrict claim routing.

**Acceptance criteria**:
- AC-1: GIVEN a task with `dependsOn: [taskA]` and `taskA.status = 'pending'`
  WHEN `claim_task` is called THEN the task is NOT returned (still blocked).
- AC-2: GIVEN `taskA.status` transitions to `completed` WHEN
  `resolveCompletedTask` runs THEN the dependent task's status becomes `pending`
  and a `task:unblocked` Pusher event is fired.
- AC-3: GIVEN `outputRequirement = 'pr_required'` and `prUrl` is null WHEN
  `complete_task` is called THEN the server returns an error — the task is NOT
  completed.
- AC-3a: GIVEN `outputRequirement = 'auto'`, `commitCount > 0`, no PR detected
  (worker-reported or via GitHub branch lookup), and no deliverable artifact
  WHEN `complete_task` is called THEN the server returns a 400 with
  `hint: 'create_pr'` — the task is NOT completed. GIVEN the same worker has
  zero commits, completion succeeds unchanged.
- AC-4: GIVEN a task that has had 3 prior `failed` workers WHEN the 4th worker
  is marked stale THEN `tasks.status = 'failed'` (permanent, no more retries).
- AC-5: GIVEN a concurrent claim race WHEN two runners call `claim_task`
  simultaneously THEN exactly one succeeds and the other receives an appropriate
  error or empty result.

**Code surface**:
- Claim route: `apps/web/src/app/api/workers/claim/route.ts`
- Worker update (PATCH): `apps/web/src/app/api/workers/[id]/route.ts`
- Dependency resolution: `apps/web/src/lib/task-dependencies.ts` —
  `resolveCompletedTask()`
- Stale reclaim: `apps/web/src/lib/stale-workers.ts` — `resolveStaleTask()`
- Schema: `packages/core/db/schema.ts` — `tasks` table

---

## Claim-gate legibility contract

Every condition that withholds a `pending` task from the claim query is a
**gate**. Gates are not optional machinery — they prevent duplicate PRs, budget
overruns and file collisions. What is not optional is that an operator can tell
a gate apart from an idle queue.

Two prod incidents defined this contract: task `aeb80faf` was unclaimable for 5
days and `640e7da2` for 24, both rendering as ordinary `QUEUED` rows, both
because a gate excluded them with no signal and no override. `aeb80faf` was
additionally the root of a 20-task dependency funnel, so one invisible gate
stalled a whole workspace.

**Invariants**: for every gate,
- **CG-1 (named)**: the gate MUST produce a stable `gateReason` string, and
  `/api/tasks/[id]/start` MUST return `422` with that reason rather than a `200`
  that dispatches nothing. A success response for a task that cannot be claimed
  is a lie the operator acts on.
- **CG-2 (visible)**: the blocking state MUST be derivable by the display layer
  from data the task list already selects, and MUST NOT render as `QUEUED`.
  Surfaces using explicit `columns` MUST select the fields their gate predicate
  reads — an unselected column reads as `undefined` and silently re-hides the
  state.
- **CG-3 (overridable or declared)**: a gate MUST either honour a documented
  bypass key (see `apps/web/src/lib/bypass-flags.ts`) or declare
  `blockClass: 'capability'`, meaning force-start is refused on purpose. A
  bypass key that no gate reads, or a gate that ignores its own key, is a false
  safety net — `bypassStartGate` and `capExempt` were both in that state.
- **CG-4 (one predicate)**: a gate's SQL prefilter and its in-loop guard MUST
  derive from one shared contract module, never two hand-synchronised copies.
  See `dep-gate-contract.ts`, `subject-gate-contract.ts`, `bypass-flags.ts`.
  Divergence in either direction is a defect: SQL stricter than TS strands the
  task, TS stricter than SQL admits work that should have waited.
- **CG-5 (terminal gates terminate)**: when a gate concludes a task can never
  become claimable, the task MUST be moved to a terminal status rather than left
  `pending`. `cancelled` is the dependency gate's satisfying status, so
  terminating a dead task is also what releases its dependents; leaving it
  `pending` starves them indefinitely.
- **CG-6 (transient gates self-clear)**: a gate that is expected to clear MUST
  do so without human action, and MUST be expressed as a soft deferral —
  `continue` plus a `deferrals` counter, retried next poll — never as a stored
  `dependsOn` edge, which waits for `completed` + PR `merged`.

**Gate inventory** (`gateReason` → class):

| gateReason | Clears by | Class |
|---|---|---|
| `deferred_start` | time (`startAt`) | policy, forceable |
| `dep_missing` / `dep_failed` / `unmerged_dep_pr` | upstream terminal state | policy, forceable |
| `mission_held` | arming the mission | policy, forceable |
| `mission_budget_exhausted` | raising the mission budget | policy, forceable |
| `subject_dead` | never (terminal) | policy, forceable |¹
| `workspace_cap_reached` | drain | policy, forceable |
| `connector_routing_mismatch` | fixing the connector | capability |

¹ `subject_dead` has its own capability spec — see
`docs/specs/subject-anchor-liveness.md` for binding classification, fail-open
semantics, terminal cancellation and the override. This table records only its
place in the gate ladder.

`StartTaskButton` also renders a `capability_mismatch` branch that no route
emits. That is deliberate, not an oversight: the capability abstraction whose
only real check was "does this backend have a credential" was removed in PR
#1864 and replaced by the onboarding/workspace-configuration path (see
`docs/SPEC.md` → Removed concepts). A task whose backend has no credential
therefore has no task-level `gateReason`, and must not be given one.

That gap is now closed at configuration time instead, by
`apps/web/src/lib/backend-strand.ts` — one module, three read-only surfaces, no
gate:
- **Settings → Agent backends** (`AgentBackendsSection.tsx`, fed by
  `GET /api/teams/[id]/backend-readiness`): each backend card states how many
  **pending** tasks are routed to it with no credential, and links to them. The
  count is the consequence a bare "not configured" chip failed to convey.
- **Health → Problems** (`HealthClient.tsx`): one row per backend that is
  stranding work, with the existing "Fix in Settings" affordance. Without it the
  page asserts "All systems healthy" while a queue can never drain.
- **`/api/cron/queue-stall`**: the `backend_credential_missing` stall reason
  (below), which names the condition in the ops alert instead of reporting the
  most permanent block it can see as `no_gate_identified`.

"Routed to" is `resolveEffectiveBackend()` in `packages/core/backend-policy.ts`:
`tasks.backend` (the mission → role → workspace chain, resolved and persisted at
creation) with the team's enabled-provider mask applied on top, exactly as the
claim route applies it at dispatch. Consequences the surfaces MUST model: a task
nominally on a **disabled** backend is not stranded (the mask reroutes it), a
task can be stranded by the mask alone (Claude disabled + Codex unconfigured
strands the whole queue), and Claude is `implicitlyConfigured`, so the common
case reports nothing.

Soft deferrals are counted in `ClaimDiagnostics.deferrals` and MUST all
self-clear: `path_overlap`, `advisory_manifest`, `mission_concurrent`,
`mission_paced`, `budget_paused`, `provider_unavailable`. They are not
`gateReason` values — `/start` does not reject on them, because by the time an
operator reads the response the deferral has usually already cleared.

They are still reportable: `/api/cron/queue-stall` names a soft deferral once a
task has been held by one for longer than the stall threshold, since "transient"
stops being an excuse at that point. `advisory_manifest` is the case that
matters — its blocking peer may be parked in `waiting_input`, holding the slot
until a human answers, which never self-clears in practice.

The watchdog reports two reasons that are NOT `gateReason` values and never will
be, ordered below every gate `/start` can name (so `/start`'s 422 ordering is
reproduced verbatim) and among themselves by permanence:
`backend_credential_missing` (permanent until an operator adds a credential),
then `advisory_manifest` (self-clearing). Reporting is not gating: the watchdog
withholds nothing from the claim query, which is why naming the missing
credential here does not reintroduce the removed capability gate.

Two entries appear in the hard-gate table above rather than here, because the
claim loop counts them but `/start` also rejects on them: `subject_dead`
(terminal) and `workspace_cap` / `workspace_cap_reached`.

**Acceptance criteria**:
- AC-CG-1: GIVEN a task excluded by any gate WHEN `/start` is called without
  `forceOverride` THEN the response is `422` with a `gateReason`, no Pusher
  broadcast is emitted and the priority is unchanged.
- AC-CG-2: GIVEN a gate with a bypass key WHEN `/start` is called with
  `forceOverride` THEN the key is written to `task.context` AND the claim query
  admits the task on the next poll.
- AC-CG-3: GIVEN a bypass key written as boolean `true` or string `'true'` THEN
  both the SQL prefilter and the in-loop guard accept it.
- AC-CG-4: GIVEN a task pending beyond `STALL_THRESHOLD_HOURS` (4h, declared in
  `apps/web/src/app/api/cron/queue-stall/route.ts:99`) with no
  successful claim THEN `/api/cron/queue-stall` reports it with the first gate
  actually blocking it — never a bare "stalled".
- AC-CG-5: GIVEN a subject-dead task with a binding anchor WHEN the
  reconciliation sweep runs THEN the task becomes `cancelled` AND its dependents
  become claimable.
- AC-CG-6: GIVEN a pending task whose effective backend has no credential THEN
  `/api/cron/queue-stall` reports `backend_credential_missing` (not
  `no_gate_identified`) AND Settings → Agent backends counts it against that
  backend AND `/start` still returns no `gateReason` for it.

**Code surface**:
- Per-gate modules: `apps/web/src/app/api/workers/claim/` —
  `connector-gate.ts`, `deferred-gate.ts`, `deps-gate.ts`, `held-gate.ts`,
  `mission-budget-gate.ts`, `pacing-gate.ts`, `subject-gate.ts`,
  `workspace-cap-gate.ts`. Each holds its SQL predicate and its per-task check
  side by side, so the claim route and `/start` cannot drift (rule CG-4). There
  is deliberately no aggregate `lib/claim-gates.ts` — it was a hand-mirrored
  copy of these predicates and was deleted in PR #1868.
- Gate contracts: `apps/web/src/lib/dep-gate-contract.ts`,
  `apps/web/src/lib/subject-gate-contract.ts`,
  `apps/web/src/lib/bypass-flags.ts`
- Override surface: `apps/web/src/app/api/tasks/[id]/start/route.ts`
- Display: `apps/web/src/lib/task-presentation.ts` — `deriveTaskPhase()`,
  `apps/web/src/components/StageChip.tsx` — `deriveStage()`
- Watchdog: `apps/web/src/app/api/cron/queue-stall/route.ts`
- Configuration-time surfacing (no gate): `apps/web/src/lib/backend-strand.ts`,
  `packages/core/backend-policy.ts` — `resolveEffectiveBackend()`,
  `apps/web/src/app/api/teams/[id]/backend-readiness/route.ts`

---

## Worker State Machine

Workers are execution sessions. A worker's `status` is separate from the task
status and tracks the agent's runtime state:

| Status | Meaning |
|--------|---------|
| `idle` | Worker row created; agent not yet started. |
| `starting` | Runner is launching the agent. |
| `running` | Agent is actively processing. |
| `waiting_input` | Agent paused, waiting for a human response. |
| `completed` | Agent finished successfully. |
| `failed` | Agent or runner encountered a terminal error. |
| `error` | System-level error (distinct from agent failure). |

**Invariants**:
- A terminal worker (`completed`, `failed`, `error`) MUST NOT accept status
  updates except a single `running` reactivation (for follow-up messages from
  the runner), and that reactivation MUST require BOTH an explicit
  `body.reactivate === true` AND a `worker.error` matching none of the
  server-expiry phrases (`Interrupted — human takeover`, `expired`, `timed out`,
  `went offline`, `runner restarted`). No named guard helper exists: both
  predicates are inline locals `reactivateRequested` and
  `isNonReactivatableTermination` in the PATCH handler
  (`apps/web/src/app/api/workers/[id]/route.ts:270–278`); failing either returns
  `409`.
- `waitingFor` MUST be cleared (`null`) automatically when status transitions
  to `running`.
- `workers.startedAt` is set the first time status becomes `running`.

**Acceptance criteria**:
- AC-6: GIVEN `worker.status = 'failed'` WHEN a PATCH with `status = 'running'`
  is received THEN the reactivation is allowed ONLY if the caller passes the
  cleanup-expiry guard; otherwise HTTP 409 is returned.
- AC-7: GIVEN `worker.status = 'waiting_input'` WHEN a PATCH with
  `status = 'running'` arrives THEN `waitingFor` is set to `null` in the same
  update.

**Code surface**:
- PATCH handler: `apps/web/src/app/api/workers/[id]/route.ts`
- Reactivation guard: same file, lines ~88–109

---

## Mission State Machine

**States**: `active` → `paused` → `active` (reversible) | `completed` →
`archived`

Mission `status` is stored in `missions.status`. Mission **health** is NEVER
stored — it is derived on read from the state of associated tasks via
`deriveMissionHealth` / `isDeliverableTask`.

**Invariants**:
- Mission status transitions (`active ↔ paused`, `active → completed`,
  `completed → archived`) are driven by human action (dashboard or MCP) or
  mission loop evaluation tasks — not by any automatic side effect.
- Every automated `active → completed` transition MUST go through
  `completeMissionIfVerified`, which is the only automated writer of
  `missions.status = 'completed'`. An agent's `missionComplete = true` — from the
  heartbeat, a planning task, or the independent evaluation task — is a PROPOSAL
  that this function may refuse.
- Health is computed from deliverable tasks only (`isDeliverableTask` filters out
  `kind = 'coordination'`, `mode = 'planning'`, and housekeeping titles).
- A paused mission MUST NOT spawn new tasks from its schedule while paused.
- A mission's `activeHoursStart/End/Timezone` fields restrict when its heartbeat
  schedule fires. When set, the cron skips firing outside the active window.
  `activeHours` gates firing cadence only — it does NOT change mission status.
  A `completed` or `paused` mission with `activeHours` set MUST NOT treat the
  active-hours window as a resume signal.
- **One task, one branch, one PR — in every branch shape.** Tasks under a mission
  MUST NOT share a branch and MUST NOT be represented by a single PR.
  `missions.workingBranch` is the mission's *integration* branch (shape
  `mission/<slug>-<id8>`, written lazily on first task creation for a mission
  whose workspace has a repo), and it is the **base** of the mission's task PRs
  only when that mission has opted in (`missions.integrationBranchEnabled`,
  default `false`). For an opted-in mission, task PRs merge into the integration
  branch and the mission's work reaches trunk through exactly one PR from that
  branch — the mission integration PR, which is the mission's single human gate.
  That PR is opened automatically: the `pull_request` webhook calls
  `maybeOpenMissionIntegrationPr` when a task PR merges, and
  `openMissionIntegrationPr` opens it once every deliverable task of the mission is
  terminal and every deliverable PR has merged into the integration branch. For every
  other mission — the default — each task PR targets the workspace's trunk branch
  and `workingBranch` retargets nothing.
- `missions.primaryPrNumber`/`primaryPrUrl` MUST only ever be claimed by a PR
  whose base ref is a trunk branch of the workspace (`gitConfig.targetBranch`,
  `gitConfig.defaultBranch`, or the repo default). A PR based on the mission
  integration branch — i.e. any task PR under an opted-in mission — MUST NOT
  claim the slot, and an unknown base ref MUST NOT claim it either. The slot
  therefore names the mission integration PR wherever one exists.
- For workspace-less missions (`workspaceId = null`), `workingBranch` and
  `primaryPrNumber`/`primaryPrUrl` are always null (no repo, no PRs).

**Acceptance criteria**:
- AC-8: GIVEN a mission with all tasks `completed` WHEN health is derived THEN
  the health reflects 100% completion (no failed deliverable tasks).
- AC-9: GIVEN a `planning` mode task linked to a mission WHEN health is derived
  THEN that task is excluded from the deliverable count.
- AC-10: GIVEN `missions.status = 'paused'` WHEN the cron schedule fires THEN
  no new task is created for that mission.
- AC-10b: GIVEN an `active` mission with `activeHoursStart/End` set and the
  current time is outside the configured window WHEN the heartbeat fires THEN
  no new task is created. The mission remains `active` — `activeHours` is a
  firing gate, not a status transition.
- AC-11: GIVEN a mission with `requiresReview = true` WHEN a task PR is created
  THEN auto-merge is suppressed and human review is required before merging.
- AC-11o: GIVEN two tasks under the same mission WHEN each opens a PR THEN the
  two PRs carry different head refs and different PR numbers — neither shape
  produces one PR for the mission's task work.
- AC-11p: GIVEN a mission with `workingBranch` set WHEN a task PR based on that
  `workingBranch` is registered THEN `missions.primaryPrNumber` is NOT written
  and the rejection is recorded with the base ref that was seen; GIVEN the same
  registration with a base ref of the workspace trunk and `primaryPrNumber`
  still null THEN the slot is claimed.

**Code surface**:
- Mission helpers: `packages/core/mission-helpers.ts` — `isDeliverableTask()`
- Mission context: `apps/web/src/lib/mission-context.ts`
- Mission API: `apps/web/src/app/api/missions/route.ts`,
  `apps/web/src/app/api/missions/[id]/route.ts`
- Integration branch generation: `apps/web/src/lib/mission-run.ts` — writes
  `missions.workingBranch` under `isNull` so the first writer wins
- Mission-PR slot gate: `apps/web/src/lib/mission-pr.ts` —
  `claimMissionPrimaryPr`, base ref checked against `trunkBranches`; called from
  `apps/web/src/app/api/github/pr/route.ts` and from the mission-PR opener, one
  implementation for both
- Mission integration PR: `apps/web/src/lib/mission-pr.ts` —
  `openMissionIntegrationPr` creates the `bookkeeping` task and worker row that
  own it, so every worker-keyed merge surface can see and merge it
- Option A′ predicates: `packages/core/mission-integration.ts` —
  `missionIntegrationBase`, `isMissionIntegrationBase`
- Seeded planner rules for both shapes: `apps/web/src/lib/default-roles.ts`
  (Organizer, "Sequencing Rules")
- Schema: `packages/core/db/schema.ts` — `missions` table

---

## Mission Completion Gate

**Capability statement**: A mission MUST NOT reach `completed` without a passing
goal-criteria verdict; completion REQUESTS a verdict, the verdict GATES
completion, and the absence of a verdict is never a pass.

One predicate — `canCompleteMission(missionId)` — answers the question for every
caller: the heartbeat's `missionComplete` signal, the heartbeat prepass, the
dormancy check, the independent evaluation task, the on-demand criteria route,
and the `on_mission_complete` release trigger. It returns
`{ ok, code, reason, pendingDeliverables, pendingByStatus, pendingAllTasks,
awaitingMerge, awaitingMergeDetails, criteriaVerdict, ... }`, and
`completeMissionIfVerified` performs the write.

Refusal order (first failure is the reported `code`): `mission_not_found` →
`mission_not_active` → `pending_deliverables` → `no_deliverables` →
`infra_stalled` → `awaiting_merge` → `criteria_failed` / `criteria_pending` /
`criteria_unverified`.

**Invariants**:
- No completion path is exempt from the predicate. In particular the heartbeat
  is NOT an evaluation authority: it is an LLM reading a checklist and does not
  count task rows.
- A refused completion MUST be diagnosable. `completeMissionIfVerified` emits a
  `mission:completion_decision` Pusher event carrying the predicate inputs
  (pending count by status, criteria verdict, deciding path) for every decision
  it makes, allowed or refused, and logs the same payload. Callers that only READ
  the predicate (`canCompleteMission` direct, e.g. the release trigger) log but
  do not emit — they decided nothing.
- A mission whose work is done but whose criteria do not pass stays `active`
  (awaiting verification), and keeps its schedule enabled for as long as the
  verdict can still be acted on. It MUST NOT be auto-archived by
  `selectMissionsToArchive` while a stated criterion lacks a passing verdict. The
  one case that stands the schedule down is escalation to the owner — see
  *Blocked-Verdict Consumer* below; the mission stays `active` and un-archived
  there too, waiting on a person rather than on a cadence.
- Any non-terminal task that is not housekeeping blocks completion — `work` AND
  `attempt`, so a pending CI retry counts. Housekeeping rows (including a
  criterion's own verification task) MUST NOT block, or a `command` criterion
  would block on itself and the mission could never close.
- **A task's terminal status is not its terminal state — its PR's state is**
  (task facae217). A `completed` deliverable whose latest worker produced a PR
  that has not merged (`prUrl` set, `mergedAt` null — open, conflicted,
  CI-failing, or closed without merging) blocks completion with
  `code = 'awaiting_merge'`, naming the task title and PR number in `reason`
  and `awaitingMergeDetails`. This check runs BEFORE the `pending_deliverables`
  short-circuit would otherwise matter and before criteria evaluation, because
  `pending_deliverables` only ever sees non-terminal rows — a deliverable that
  already reached `completed` with an unmerged PR sails past it. It also runs
  regardless of whether criteria are stated or would pass: an unmerged PR means
  the deliverable did not ship, independent of what the criteria say. Observed
  as mission 50d29836 ("M4"): dormancy's own reason string read "All
  deliverables terminal; mission states no goal criteria" while the sole
  deliverable's PR sat open with a reviewer's "changes requested" verdict and a
  retry queued — dormancy is not exempt from this check any more than the
  heartbeat is; both route through the same predicate. The refusal note posts
  unconditionally for `awaiting_merge` (not gated on `opts.proposed`), unlike
  the criteria block notes, because dormancy never sets `proposed` and the
  M4 refusal must still be visible in the feed.
- The `awaiting_merge` gate does not distinguish "queued retry in flight" from
  "nobody has looked at it yet" — both are an unmerged PR on a completed task,
  and both block. A mission progress surface may render them differently (see
  `mission-structure-view.md` / `CondensedTimeline.tsx`'s `waitingOnYou` group,
  which every completed task with an unmerged PR enters unconditionally — no
  merge-policy-tier or reviewer-verdict carve-out decides group placement,
  after the same incident revealed one had silently reintroduced this bug at
  the UI layer), but the completion predicate treats every unmerged-PR shape
  the same way: blocked, no exceptions.
- A mission with no deliverable rows at all MAY be completed only by an explicit
  proposal (`proposed: true`), never by dormancy: a monitoring mission's output
  is its heartbeat cycles, which are housekeeping rows.
- When all deliverables are terminal and criteria are stated, the predicate MUST
  attempt evaluation rather than reading a possibly-absent stored verdict. The
  evaluator MUST NOT skip on the grounds that pending work exists — that was the
  deadlock: the skip condition and the completion condition were the same
  condition.
- Verdicts are not one-shot. Mechanical criteria are re-evaluated on every
  request; a `command` verdict older than `COMMAND_VERDICT_TTL_MS` is re-run; an
  LLM-graded verdict is reused for at most `LLM_REVERIFY_MS`.
- Reuse of a stored verdict MUST match on `criterionFingerprint`, never on array
  index alone: deleting one criterion renumbers the rest, and an index-keyed
  cache would transplant a verdict onto a criterion nobody evaluated.
- A task's terminal status is NOT a verdict. A `command` criterion may only be
  passed on evidence that the command ran (runner `verificationEvidence`, or the
  `loopHistory` written from it) — a task can reach `completed` without running
  it, e.g. a stale-worker retry clone that carries no `loopConfig`.
- No command criterion is dispatched while another criterion already reads
  `fail`: the fold cannot pass this round, so the run would buy nothing.
- `command` criteria MUST be verified by execution: buildd dispatches a
  `taskClass = 'bookkeeping'` verification task carrying
  `loopConfig.exitCondition = { type: 'command', command }`, and the runner's
  evidence — not an agent's summary — decides. A `command` criterion MUST NOT be
  graded by the LLM evaluator.
- `description` (prose) criteria MUST NOT depend on `ANTHROPIC_API_KEY` being
  present in the web app's environment. That variable is unset in production and
  is unsettable for a team whose Claude access is an OAuth subscription, so a
  grader keyed on it reported `NOT_EVALUATED` forever and named a fix no operator
  could apply. When the key is absent the evaluator MUST dispatch a
  `taskClass = 'bookkeeping'` grading task instead, which a runner claims with
  whatever backend credential the team has connected, and mark the criteria
  `PENDING`. When the key IS present the inline call is used and no task is
  dispatched — never both.
- A prose grading task is deduplicated on its `context.criteriaProseEval` marker,
  matched in SQL. Mechanical evaluation re-runs on every completion attempt, so an
  undeduplicated dispatch would create one grading task per round.
- A prose verdict MUST be written back only onto the criterion it graded, matched
  on `criterionFingerprint`, and only for indices named in the dispatching
  marker: an agent MUST NOT be able to overwrite a mechanically-derived verdict
  with prose. Every criterion in the marker leaves the write-back non-`PENDING`,
  including ones the evaluator ignored — a criterion left `PENDING` with no task
  in flight holds the mission open with nothing that could resolve it.
- No prose criterion is dispatched while another criterion already reads `fail`,
  and a finished grading run that returned no verdicts is not retried until it
  ages past `PROSE_VERDICT_TTL_MS` — the same economics as the command path.
- The release trigger keeps one additional bar above the predicate: no task of
  the mission in `pending`, `assigned`, or `in_progress`, housekeeping rows
  included (`countPendingTasksForMission`). It MUST NOT be loosened to match a
  weaker completion predicate. It reads the criteria verdict rather than
  producing one (`evaluateCriteria: false`), and accepts a mission that is
  already `completed`/`archived` — that mission passed the gate when it closed.
- `POST`/`PATCH /api/missions` MUST reject a `description` criterion that omits
  `notMechanizableReason` (HTTP 400), a `command` criterion with no command, and
  a `metric` criterion (no evaluator exists, so it would block permanently).
  A criterion byte-identical to one already stored on the mission is
  grandfathered, so history cannot block the edit that would fix it.
- An explicit `PATCH status: 'completed'` bypasses the gate by design (a person
  may override) but MUST post a `Goal criteria gate overridden` note naming the
  actor when the stored verdict is not `pass` — the endpoint is also reachable
  with an admin API key.

**Acceptance criteria**:
- AC-11a: GIVEN a heartbeat planning task with `result.missionComplete = true`
  and one deliverable task in `pending` WHEN the mission loop runs THEN the
  mission status remains `active` and a `Mission awaiting verification` note
  names the pending count.
- AC-11b: GIVEN all deliverables terminal and `goalCriteriaState.overall` absent
  WHEN completion is attempted THEN criteria evaluation is invoked, and if it
  still yields no passing verdict the mission remains `active` with
  `code = 'criteria_unverified'`.
- AC-11c: GIVEN all deliverables terminal and every criterion `pass` WHEN
  completion is attempted THEN `missions.status` becomes `completed`, the linked
  schedule is disabled, and the `on_mission_complete` release trigger also
  passes its own check.
- AC-11d: GIVEN a mission with a `description` criterion, no `ANTHROPIC_API_KEY`
  in the environment, and a connected agent backend credential WHEN criteria are
  evaluated THEN one `bookkeeping` grading task is dispatched, the criterion reads
  `PENDING` with that task id, and `overall` is `UNVERIFIED` — and WHEN that task
  completes with `criteriaVerdicts` THEN the verdicts land on the criteria,
  `overall` is re-folded, and completion is re-attempted in the same request.
- AC-11e: GIVEN the same mission with NO agent backend credential connected WHEN
  criteria are evaluated THEN no task is dispatched and the criterion reads
  `NOT_EVALUATED` with evidence naming Settings → Agent Backends.
- AC-11d: GIVEN a `command` criterion WHEN a verdict is owed THEN a verification
  task is dispatched, the criterion reads `PENDING` with its `workerTaskId`, and
  the mission does NOT complete until that task's evidence resolves it.
- AC-11e: GIVEN `POST /api/missions` with
  `goalCriteria: [{ type: 'description', description: '...' }]` and no
  `notMechanizableReason` THEN the request is rejected with HTTP 400 naming
  `notMechanizableReason`.
- AC-11f: GIVEN an `active` mission with all tasks completed, no enabled
  schedule, 24h of quiet, and a stated criterion whose verdict is not `pass`
  WHEN the archive sweep runs THEN the mission is NOT archived.
- AC-11g: GIVEN a mission with one completed deliverable and one `pending` task
  of `taskClass = 'attempt'` (a CI retry) WHEN completion is attempted THEN it is
  refused with `pending_deliverables`.
- AC-11h: GIVEN a mission whose only rows are housekeeping (a monitoring mission)
  WHEN a heartbeat proposes completion and criteria pass THEN the mission
  completes; WHEN dormancy checks the same mission THEN it is refused with
  `no_deliverables`.
- AC-11i: GIVEN a completed `command` verification task carrying no record that
  the command ran WHEN its outcome is handed back THEN the criterion is NOT set
  to `pass`.
- AC-11o: GIVEN a mission with one `completed` deliverable whose latest worker
  has `prUrl` set and `mergedAt` null, and no `goalCriteria` stated (the M4
  shape) WHEN dormancy OR the heartbeat attempts completion THEN the mission
  stays `active` with `code = 'awaiting_merge'`, the reason and
  `awaitingMergeDetails` name the task title and PR number, and a feed note
  posts even though nothing "proposed" completion.
- AC-11p: GIVEN the same mission WHEN the PR merges (`mergedAt` set) THEN a
  subsequent completion attempt with no other blockers succeeds.
- AC-11q: GIVEN a mission with a `completed` deliverable whose PR was closed
  without merging (`prLifecycleStatus = 'closed'`, `mergedAt` null) WHEN
  completion is attempted THEN it is refused with `code = 'awaiting_merge'` —
  a closed-unmerged PR is not a passing outcome either.

### Blocked-Verdict Consumer

**Capability statement**: A non-passing verdict MUST have a consumer. A mission
that can be BLOCKED by its criteria but cannot file the work to unblock itself is
a deadlock, and a verdict re-produced on a cadence and read by nobody is that
deadlock's signature.

Observed shape: with every deliverable terminal and criteria failing, the
heartbeat prepass proposed completion, the gate refused, the schedule deferred,
and the tick ended — so the only branch that dispatches an organizer cycle
(`invoke_llm`, which requires open deliverables) was structurally unreachable.
Four missions sat in that state, one for ~40 cycles, each finished by hand.

**Invariants**:
- A refusal whose `code` satisfies `isCriteriaBlockCode` MUST dispatch exactly ONE
  organizer cycle per distinct verdict shape, carrying the per-criterion verdict
  text into the planning description — the `failureContext` pattern, applied to a
  criteria failure.
- Verdict shape is `criteriaFingerprint`: `overall` plus each criterion's verdict
  keyed on `criterionFingerprint` (falling back to index). Evidence WORDING is
  excluded: an LLM re-grading the same failure phrases it differently every run,
  and treating rewording as new information defeats the loop guard.
- The EVALUATOR MUST NOT file work. Prose criteria are LLM-graded and the least
  reliable signal in the system; a grader with write access to the backlog turns a
  hallucinated verdict into hallucinated scope. The consumer decides only whether
  to WAKE the organizer; the organizer decides what to file.
- Re-arming MUST NOT loop. An unchanged verdict escalates: after
  `MAX_REARM_CYCLES` unchanged cycles, or immediately once the organizer has seen
  that exact verdict and filed nothing against it, buildd posts a `question` note
  naming the blocking criteria and disables the heartbeat schedule. A criteria
  failure nobody can move is a decision, not a retry.
- While work filed against the current verdict is still open, the consumer waits
  rather than re-arming — otherwise it duplicates the work in flight.
- Escalation MUST be self-clearing: any change in verdict shape re-arms the
  organizer and clears `criteriaEscalatedAt`, so an owner fixing a criterion (or
  a merge flipping `all_prs_merged`) resumes the mission without a manual restart.
- A re-arm cycle MUST NOT write `lastHeartbeatStateHash`. Mission state is
  unchanged by construction (every deliverable is terminal), so persisting it
  would make the next tick read "no change" and suppress the cycle just
  authorised.
- Coordinate-only mode (`decompositionSkipped`) is LIFTED, narrowly, for gaps
  named in a non-passing criterion. Pre-filed tasks are a reason not to duplicate
  decomposition; they are not a reason to be unable to fix a criterion the mission
  is failing. The lift MUST NOT authorize re-decomposition of anything the
  blocking criteria do not name.

**Acceptance criteria**:
- AC-11j: GIVEN a heartbeat mission with every deliverable terminal and
  `overall = fail` WHEN the cron tick runs THEN one planning task is created for
  the mission and its context carries `criteriaRearm` with the non-passing
  criterion lines — not a bare deferral.
- AC-11k: GIVEN the same mission on a later tick with the verdict shape unchanged
  and no task filed since the last re-arm WHEN the tick runs THEN no cycle is
  created, a `Goal criteria blocked — owner decision needed` note is posted, and
  the heartbeat schedule is disabled with
  `lastDeferralReason = 'criteria_escalated'`.
- AC-11l: GIVEN an escalated mission WHEN a criterion's verdict changes THEN the
  next tick re-arms the organizer and `criteriaEscalatedAt` is cleared.
- AC-11m: GIVEN a completion refused for a non-criteria reason (e.g.
  `infra_stalled`) WHEN the tick runs THEN no re-arm is attempted.
- AC-11n: GIVEN a re-arm cycle WHEN the schedule row is written THEN
  `lastHeartbeatStateHash` is not among the written columns.

**Code surface**:
- Predicate + writer: `apps/web/src/lib/mission-completion.ts` —
  `canCompleteMission()`, `completeMissionIfVerified()`, `isCriteriaBlockCode()`
- Blocked-verdict consumer: `apps/web/src/lib/criteria-rearm.ts` —
  `criteriaFingerprint()`, `decideCriteriaRearm()`, `applyCriteriaRearm()`
- Re-arm prompt injection: `apps/web/src/lib/mission-context.ts` —
  `buildMissionContext()` (`criteriaRearm` block + coordinate-only lift)
- Verdict producer: `apps/web/src/lib/mission-criteria-eval.ts` —
  `ensureCriteriaVerdict()`, `evaluateCriteriaNow()`
- Command criteria: `apps/web/src/lib/mission-criteria-verify.ts` —
  `resolveCommandCriterion()`, `handleCriteriaVerificationOutcome()`
- Prose criteria: `apps/web/src/lib/mission-criteria-prose.ts` —
  `resolveProseCriteria()`, `handleProseEvalOutcome()`
- Pure evaluator + form validation: `packages/core/mission-helpers.ts` —
  `evaluateGoalCriteria()`, `recalculateOverall()`, `validateGoalCriteria()`,
  `computeMissionProgress()` (`awaitingMerge` count, `MissionSegmentState`
  `'half'` = awaiting merge / `'notch'` = closed-unmerged or failed —
  `completedTasks` counts only `'solid'` segments, never `'half'`)
- Timeline group placement: `apps/web/src/lib/condensed-timeline.ts` —
  `isWaitingOnYou()` (every `completed` task with an unmerged, non-closed PR
  enters `waitingOnYou`, unconditionally), consumed by
  `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` and
  `CondensedTimeline.tsx` (`PrStatusLine` renders closed-unmerged distinctly)
- Callers: `apps/web/src/lib/mission-loop.ts`,
  `apps/web/src/app/api/cron/schedules/route.ts` (heartbeat prepass site),
  `apps/web/src/lib/mission-evaluation.ts`,
  `apps/web/src/lib/mission-release.ts`,
  `apps/web/src/app/api/missions/[id]/evaluate/route.ts`,
  `apps/web/src/app/api/workers/[id]/route.ts`
- Archive guard: `apps/web/src/lib/mission-archive.ts` —
  `selectMissionsToArchive()`
- Display: `apps/web/src/lib/mission-helpers.ts` —
  `deriveMissionDisplayState()` (`awaiting_verification`)

**Out of scope**: The `metric` criterion evaluator (no metric-query registry
exists yet, so `metric` criteria stay `UNVERIFIED` and block completion by
design) and initiative KPI evaluation, which has no evaluator at all.

---

## Mission Dormancy Pattern (long-horizon missions)

For missions with a defined active season (e.g., annual tax prep Jan–Mar,
quarterly review), the recommended pattern is:

- Keep `status = 'active'` year-round — do NOT use `paused` for seasonal gaps.
- Set `activeHoursStart/End/Timezone` to a narrow window (e.g., 9–10 AM
  Chicago) so the heartbeat fires infrequently and does not spam task creation.
- Write heartbeat logic that checks the current date against the mission's
  documented season window before spawning tasks. When outside the season, the
  heartbeat should log a status note and return without creating tasks.

**Contrast with `paused`**: Use `paused` for human-suspended missions awaiting
explicit manual resume. Use `active + restrictive activeHours + self-suppressing
heartbeat` for missions that auto-manage their own seasonal cadence. Mixing the
two (pausing a seasonal mission to prevent off-season tasks) is valid but means
the heartbeat must be manually re-enabled each season.

**Schema gap**: There is no `resumeAt timestamp` field for formal hibernation
with a scheduled wake date ("pause until 2027-01-15"). The workaround is
heartbeat self-suppression. A `missions.resumeAt` column is a candidate future
addition for missions that need hard-scheduled wake-up semantics.

---

## Workspace-less Missions

Missions with `workspaceId = null` are valid. They are used for:
- **Personal-agent missions**: financial tasks, email triage, annual-cycle
  planning with no code deliverables.
- **Cross-workspace coordination**: an organizer mission that dispatches tasks
  to multiple workspaces, each task carrying an explicit `workspaceId`.

**Invariants**:
- `workingBranch` and `primaryPrUrl` are always null for workspace-less
  missions (no repo, no PRs). Do not treat null values for these fields as an
  error or health failure.
- A mission with `workspaceId = null` and zero deliverable tasks MUST return a
  "no tasks" health signal. This is expected — workspace-less missions may have
  no code deliverables by design.
- Task creation from a workspace-less mission MUST supply an explicit
  `workspaceId` on each created task. There is no automatic inference from the
  mission to the task. If the heartbeat or organizer omits `workspaceId` on a
  task, that task's `workspaceId` is driven by whichever workspace the executing
  runner claims from.

**Acceptance criteria**:
- AC-14: GIVEN a workspace-less mission with no tasks WHEN health is derived
  THEN the result is "no tasks" (not "healthy" and not an error).
- AC-15: GIVEN a workspace-less mission WHEN its detail page loads THEN
  `workingBranch` and `primaryPrUrl` display as absent (not as broken links).

---

## `deriveMissionHealth` contract

**Capability statement**: `deriveMissionHealth` MUST compute the health of a
mission from its live task list without reading from any stored health column.

**Invariants**:
- Only deliverable tasks (`isDeliverableTask()` returns `true`) count.
- A mission with zero deliverable tasks MUST return a "no tasks" or "empty"
  health signal (not "healthy").

**Acceptance criteria**:
- AC-12: GIVEN tasks `[{status:'completed'}, {status:'failed'}, {kind:'coordination'}]`
  WHEN health is derived THEN the coordination task is excluded and health
  reflects 1 completed, 1 failed deliverable.
- AC-13: GIVEN a task with `title: 'Aggregate results: …'` WHEN `isDeliverableTask`
  is called THEN it returns `false`.

**Code surface**:
- `packages/core/mission-helpers.ts` — `isDeliverableTask()`

**Out of scope**: Sub-missions (`parentMissionId`) lifecycle. Mission heartbeat
scheduling (covered by `task-schedules`). The mission loop orchestration agent
logic (runner-side, not coordination layer).

---

## Organizer prior-work retrieval contract

**Capability statement**: Every mission planning pass — whether triggered by cron
(heartbeat) or manually — MUST inject a "Related prior work" block retrieved from
the KnowledgeStore before the organizer decides what tasks to create.

**Corpora queried** (all best-effort, failures silently skipped):

| Corpus | Namespace | Purpose |
|--------|-----------|---------|
| `memory` | `{teamId}:memory` | Team lessons and gotchas |
| `task` | `{workspaceId}:task` | Prior task outcomes |
| `pr` | `{workspaceId}:pr` | Pull request diffs (change history) |
| `code` | `{workspaceId}:code` | Current code index |
| `plan` | `{workspaceId}:plan` | Prior decomposition plans |

Cap: 3 hits per corpus to bound prompt growth.

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
