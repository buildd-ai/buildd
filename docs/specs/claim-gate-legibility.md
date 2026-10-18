---
title: Claim Gate Legibility
status: active
owner: max
last_verified: 2026-10-18
summary: Every condition withholding a pending task MUST have an observable claim-gate reason.
domain: tasks
surfaces: [apps/web/src/app/api/workers/claim/route.ts, packages/core/db/schema.ts]
related: [task-state-machine, mission-completion, organizer-context, mission-surface-audit]
verified_by: [apps/web/src/app/api/workers/claim/route.test.ts]
assertions:
  - id: "claim-task"
    type: "route"
    method: "POST"
    path: "/api/workers/claim"
    file: "apps/web/src/app/api/workers/claim/route.ts"
  - id: guard-1
    type: test_file
    path: apps/web/src/app/api/workers/claim/route.test.ts
---
# Claim Gate Legibility

**Capability statement**: Every condition withholding a pending task MUST have an observable claim-gate reason.

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

- **CG-7 (a reservation is a lease, not a lock)**: a session MAY reserve one
  waiting task (`update_task reserve`, or `create_task claim`, which files it
  already reserved). While the reservation is live, runners and every other
  account's claim MUST skip the task, and the reserving account's own explicit
  `claim_task {taskId}` passes. It MUST lapse by itself at `expiresAt` with no
  sweep, MUST be cleared when the task is claimed (so a re-queue is not held from
  runners), and is never lifted by an admin force claim. It is a claim exclusion
  (`task_reserved`), not a coordination `WaitingKind`: the task page does not
  yet name it.

**Gate inventory** (`gateReason` → class):

| gateReason | Clears by | Class |
|---|---|---|
| `deferred_start` | time (`startAt`) | policy, forceable |
| `dep_missing` / `dep_failed` / `unmerged_dep_pr` | upstream terminal state | policy, forceable |
| `mission_held` | arming the mission | policy, forceable |
| `mission_local` | a verified interactive session's explicit claim, or `executor: 'runner'` | policy, forceable |
| `task_held` | a person resumes the task (`context.heldBy`) | hold, never forced |
| `task_reserved` | the reserving session claims it, releases it, or the reservation lapses (`context.reservedBy`, 20 minutes, renewed by that session) | hold, never forced |
| `mission_budget_exhausted` | raising the mission budget | policy, forceable |
| `subject_dead` | never (terminal) | policy, forceable |¹
| `workspace_cap_reached` | drain | policy, forceable |
| `connector_routing_mismatch` | fixing the connector | capability |

¹ `subject_dead` has its own capability spec — see
`docs/specs/subject-anchor-liveness.md` for binding classification, fail-open
semantics, terminal cancellation and the override. This table records only its
place in the gate ladder.

`TaskActionZone` (the one task-action renderer) also renders a `capability_mismatch` branch that no route
emits. That is deliberate, not an oversight: the capability abstraction whose
only real check was "does this backend have a credential" was removed in PR
#1864 and replaced by the onboarding/workspace-configuration path (see
`docs/SPEC.md` → Removed concepts). A task whose backend has no credential
therefore has no task-level `gateReason`, and must not be given one.

That gap is now closed at configuration time instead, by
`apps/web/src/lib/backend-strand.ts` — one module, three read-only surfaces, no
gate:
- **Settings → Models**, in each provider's row (`AgentBackendsSection.tsx`, fed by
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
self-clear: `path_overlap`, `mission_concurrent`, `mission_paced`,
`budget_paused`, `provider_unavailable`. (`advisory_manifest`, the old
one-scope-undeclared-task-per-mission deferral, is retired: undeclared scope
starts by default, `claim-overlap-scheduling` I-39. Its counter stays at 0.) They are not
`gateReason` values — `/start` does not reject on them, because by the time an
operator reads the response the deferral has usually already cleared.

They are still reportable: `/api/cron/queue-stall` names a soft deferral once a
task has been held by one for longer than the stall threshold, since "transient"
stops being an excuse at that point. Rows of the retired `advisory_manifest`
deferral written before it was retired are still read, and age out of the
window.

A workspace whose `gitConfig.claimPlanner` is `apply` claims in the batch
planner's order instead (`apps/web/src/app/api/workers/claim/claim-plan-input.ts`).
A task the plan orders behind a blocker reports the soft deferral
`ordered_behind` in place of `path_overlap`, written once
per (task, blocker) pair, so repeated polls add no rows. The default `off` MUST
leave the claim exactly as described above. Explicit `taskId` claims never plan.

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

**Local-executor missions** (`missions.executor = 'local'`, default
`'runner'`). A person runs the mission's tasks from their own interactive
session (Claude Code plus local subagents). The executor is orthogonal to the
hold:

- **LX-1**: runners never auto-claim a local mission's task — the
  `missionNotLocal()` predicate in `held-gate.ts` excludes it from every claim
  that is not a verified interactive session's explicit `claim_task {taskId}`.
- **LX-2**: that explicit claim (`verifyInteractiveSession` marker + `taskId`)
  is admitted and produces a normal tracked worker (runner `mcp`), so the task
  ends with a worker, PR link and cost like any other. A runner's or an
  unverified caller's explicit claim is refused and the exclusion probe names
  it: `mission_local`, "This mission runs in a local session".
- **LX-3**: held wins. `missionNotHeld()` still applies to the interactive
  claim; a held local mission is paused for everyone and reads HELD.
- **LX-4**: force-start keeps working. `/start` without `forceOverride` returns
  `422 mission_local`; with it, `bypassHeldGate` is written and lifts this gate
  as well as the hold. An admin `claim_task force: true` lifts it too.
- **LX-5**: display. A local mission is active work: chip `LOCAL`, list status
  `Local`, grouped with running missions, never HELD / "arm to start" and never
  STALLED / "dispatch a worker". A queued task reads "Ready to start from a
  local session", claimed work reads "1 task in progress in a local session",
  and `/api/cron/queue-stall` does not report it.

- **LX-6**: stranded. A local, unheld mission is *stranded* when it holds a
  claimable task (pending, every dependency met by the claim gate's own rule,
  start floor passed) and nothing has touched any of its workers for
  `LOCAL_SESSION_QUIET_MS` (30 minutes), measured from the later of the last
  session touch and the moment the oldest claimable task became claimable.
  `deriveLocalStrand` (`apps/web/src/lib/local-strand.ts`) is the one
  predicate; the card, the mission page, `explain` and the chat mission object
  hand its answer to `deriveMissionStateView` as `localStrand`. A stranded
  mission reads chip `STRANDED`, list status `Stranded`, kind
  `awaiting_decision` (so it is an ask: NEEDS YOU), headline "Stranded: no
  local session for Xm. Continue on a runner?". It outranks failures and
  unmerged PRs, which stay in `outstanding`: a reviewer nobody claims is why
  the PR sits. Held still wins (LX-3).
- **LX-7**: "Continue on a runner". The stranded card's primary action flips
  `executor` to `runner` through the mission PATCH, which re-dispatches the
  open tasks. `continueOnRunnerBlockedReason` is the refusal: the PATCH returns
  `409` with it on a local → runner flip of a terminal mission or one with no
  workspace, and the card computes the same reason at render time and shows the
  button disabled with it — never hidden. "Keep local" changes nothing and
  shows the `claim_task {taskId}` hint.
- **LX-8**: the decision shadow. With the team's `mission_strand_choice`
  capability on, a decision model picks `continue-on-runner` |
  `wait-for-local` | `blocked-on-deps` from structured facts only and logs a
  `[decision-shadow]` line. In `shadow` mode (`STRAND_CHOICE_MODE`) nothing
  changes; in `gated` mode a confident pick may only reorder the two buttons.
  It never flips the executor. Each tap is recorded as a `[decision-label]`
  line by `POST /api/missions/[id]/strand-choice`.
- **LX-9**: dependency-blocked work is not an ask (any executor). When every
  open task is waiting on an unmet dependency, the reading is `waiting`, the
  headline names the blockers ("1 task is waiting on #3319 and #3317 to
  merge") and the next action is "Nothing to do yet. Unblocks when #3319 and
  #3317 merge." — never "Dispatch a worker". A task PR with an open attempt (a
  reviewer queued or reviewing, a fix being pushed) is the platform's move, not
  an unmerged PR for the owner (`ownerUnmergedPrs`, read by the card and by
  `explain` alike). A green PR with nobody on it is still the owner's merge,
  and that merge is the action the card offers.
- **LX-10**: retired with the per-mission scope-undeclared serialization it
  exempted: no claimant, local or runner, is deferred for declaring no files
  (`claim-overlap-scheduling` I-39).
- **LX-11**: an open question is the person's move (any executor). A worker
  parked on a question (`waiting_input`: a runner agent's AskUserQuestion or a
  local session's `ask_human`) still counts as live, so `missionOpenQuestions`
  (`apps/web/src/lib/open-ask.ts`) hands the asking tasks to
  `deriveMissionStateView` as `openQuestions`. It outranks the live-worker
  rule: kind `awaiting_decision` (NEEDS YOU), focus `human_decision` with
  `question`, headline the question itself ("N questions for you" for
  several, "An agent is waiting for your answer" with no question text), next
  action "Answer it on the task page to continue.", and the causal line reads
  `"<task>" asks: <question>`, never "a worker is running it". Its action
  ("Answer the question") opens the task page with the answer focused
  (`taskAnswerHref`), never the mission sheet. The chip keeps saying who runs
  the work (`LOCAL` / `RUNNING`). Held still wins; a failed deliverable still
  leads the headline. The Board counts the same task in its waiting-on-you
  count (`deriveFeedTaskState`, `isOpenAsk`), with the asking worker as the
  task's worker whatever order the query returned (`toBoardTaskInput`).

Use `executor: 'local'` for work someone runs locally. `startMode: 'held'` is a
pause: it also blocks the interactive claim, so it was never a fit for that.

**Acceptance criteria**:
- AC-51: GIVEN a task excluded by any gate WHEN `/start` is called without
  `forceOverride` THEN the response is `422` with a `gateReason`, no Pusher
  broadcast is emitted and the priority is unchanged.
- AC-52: GIVEN a gate with a bypass key WHEN `/start` is called with
  `forceOverride` THEN the key is written to `task.context` AND the claim query
  admits the task on the next poll.
- AC-53: GIVEN a bypass key written as boolean `true` or string `'true'` THEN
  both the SQL prefilter and the in-loop guard accept it.
- AC-54: GIVEN a task pending beyond `STALL_THRESHOLD_HOURS` (4h, declared in
  `apps/web/src/app/api/cron/queue-stall/route.ts`) with no
  successful claim THEN `/api/cron/queue-stall` reports it with the first gate
  actually blocking it — never a bare "stalled".
- AC-55: GIVEN a subject-dead task with a binding anchor WHEN the
  reconciliation sweep runs THEN the task becomes `cancelled` AND its dependents
  become claimable.
- AC-56: GIVEN a pending task whose effective backend has no credential THEN
  `/api/cron/queue-stall` reports `backend_credential_missing` (not
  `no_gate_identified`) AND Settings → Models counts it against that
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

**Out of scope**: The sibling contracts linked in the frontmatter.
