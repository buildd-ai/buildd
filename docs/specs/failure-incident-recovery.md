---
title: Failure Incident Recovery
status: active
owner: max
last_verified: 2026-10-11
summary: A failure incident MUST carry one fresh, versioned recovery assessment that is re-checked before any repair, resolved only by a passing check, and shown identically on every surface.
domain: tasks
surfaces: [apps/web/src/lib/failure-incident-recovery.ts, apps/web/src/lib/failure-incident-recovery-path-overlap.ts, apps/web/src/lib/failure-incident-store.ts, apps/web/src/lib/failure-incident-escalation.ts]
related: [path-claim-ownership, task-dispatch-authority, claim-ordering, workflow-state-kernel, decision-kinds, surface-ia-home-missions-initiatives, execution-control-plane]
keywords: [failure_incidents, Failure Pattern Sentinel, incident, path_overlap_stall, path_overlap.no_progress, recovery assessment, Needs You, no_next_step, Nothing is fixing it, escalation gate, incident page, stale incident, reopen, dismiss, infrastructure failure, capability gap, needs_operator, How should I proceed, surface audit boot failure, artifact_revisions immutable]
verified_by: [apps/web/src/lib/failure-incident-recovery.test.ts, apps/web/src/lib/failure-incident-store.test.ts, apps/web/src/lib/failure-incident-actions.test.ts, apps/web/src/lib/failure-incident-escalation.test.ts, apps/web/src/lib/failure-pattern-sentinel.test.ts, apps/web/src/lib/failure-pattern-sweep.test.ts, packages/core/__tests__/gate-events.test.ts, apps/web/src/lib/pr-reconcile.test.ts, apps/web/src/lib/pr-merged-work.test.ts]
supersedes: []
---

# Failure Incident Recovery

**Capability statement**: Every open failure incident MUST carry one recovery
assessment. The assessment says what is wrong, what Buildd is doing about it and
when it checks next. Buildd MUST re-observe the facts before every repair, MUST
spend at most a fixed budget of repairs per cause, and MUST resolve the incident
only when a stated check passes on fresh evidence. When Buildd cannot recover on
its own, the person MUST be asked for one concrete, typed action. The incident
page, Home's Needs You list, the nav badge and the push MUST all show that one
assessment.

This spec owns the Failure Pattern Sentinel's incident ledger and its recovery
layer. There was no owning spec before: the ledger (#4066) and the escalation
adapter (#4294) shipped against code comments and a private design. §1 records
the baseline the gaps in §2 were found against; §1.5 records what workstream
(a) changed. §3–§10 are the contract. Path overlap (`path_overlap_stall`) is
the first family. The contract is written so that every other
`FailureIncidentRule` can implement it without changing it. §16 extends it to
infrastructure failures that today surface as a person's question, and §17 is
the surface/state matrix every surface is held to.

Status is `active`: workstream (a) shipped the assessment, the path-overlap
policy, the merge hooks and the backstop, guarded by the `verified_by` tests.
Workstreams (b) and (c) and the §16 family are not built yet; their sections
say NOT IMPLEMENTED where it matters.

---

## 1. Reconciled baseline (what ships today)

### 1.1 Components

| Piece | File | What it does today |
|---|---|---|
| Rule engine (pure) | `apps/web/src/lib/failure-pattern-sentinel.ts` | `detectFailurePatterns` turns `SentinelFacts` into candidates. `rulePathOverlapStall` groups stalled path-overlap deferrals by blocking PR. It uses reason code `path_overlap.no_progress` and the signature `path_overlap_stall\|ws=<id>\|blocker=pr:<n>`. The stall threshold is `pathOverlapStallMinutes` (120). Severity is high at `pathOverlapHighTasks` (3) tasks or at 4× the threshold. |
| Collector + orchestration | `apps/web/src/lib/failure-pattern-sweep.ts` | `runFailurePatternSweep` runs from the debounced trigger (`apps/web/src/lib/failure-pattern-sentinel-trigger.ts`) and from the 30-minute cron backstop (`apps/web/src/app/api/cron/failure-pattern-sentinel/route.ts`). Path-overlap facts come from `gate_events` rows with gate `claim_loop_deferral` and reason `path_overlap` over a 1440-minute lookback, collapsed to one entry per task. |
| Ledger | `apps/web/src/lib/failure-incident-store.ts` | There is one `failure_incidents` row per (signature, detectorVersion). `upsertIncident` folds candidates in, using a CAS on `version`. `mergeIncident` reopens a `resolved` row when a fresh occurrence arrives. `applyIncidentAction` and `updateIncidentState` support `acknowledge`, `resolve`, `alerted` and `link_fix_task`. |
| Action layer | `apps/web/src/lib/failure-incident-actions.ts` | `actOnIncidentResults` runs only on transitions (opened, updated or reopened). It triages through the `buildd.failure_incident_triage` decision kind, files at most one fix task per incident (`createDbFixTaskPort`, claim key `failure-incident-fix:<id>` in `system_cache`), and claims a page on the row (`claimIncidentAlert`, `planIncidentAlert`). |
| Escalation adapter | `apps/web/src/lib/failure-incident-escalation.ts` | `createGatedIncidentSender` checks the rules in `incidentEscalationRule` (resolved: hold; critical: person; fix task running: `wait_machine`; high: person with rail `no_next_step`; otherwise hold). It records the verdict in `decision_records` (capability `escalation_gate`, subject `incident:<id>`, fingerprint `incidentFingerprint`) and pages through `notifyTeam` (Pushover or webhook) only when the verdict is the person's. |
| Home | `apps/web/src/lib/failure-incident-escalation.ts` | `loadIncidentNeedsYou` reads unresolved high and critical incidents together with the newest stored verdict (`loadIncidentVerdicts`). `incidentNeedsYouItems` lists only incidents whose verdict is the person's. `resolveQueueAttention` (`apps/web/src/lib/home-attention.ts`) turns each one into an `incident` card, and `publishHomeAttentionCount` counts it in the nav badge. |
| Incident page | `apps/web/src/app/app/(protected)/incidents/[id]/page.tsx`, `apps/web/src/lib/incident-view.ts` | A read-only server page: `incidentStateLine`, then "Why it came to you" or "Who has it", then "Fix" (the linked task, or the literal text *Nothing is fixing it.*), then "Affected". It has no action buttons. |
| Incident list | `apps/web/src/app/api/health/incidents/route.ts` | `GET` only. MCP `list_incidents` is a read proxy. |

**A different family, kept separate.** `trunk_incidents`
(`apps/web/src/lib/workflow/trunk.ts`, workflow-state-kernel §5.8) belong to the
workflow kernel and already resolve themselves through the kernel's recovery
sweep. This spec does not merge the two incident tables or reuse that
lifecycle writer.

### 1.2 Existing fields this contract reuses

- `failure_incidents` columns:
  - `status` (`open` \| `acknowledged` \| `resolved`)
  - `severity`, a floor that only ever rises
  - `firstSeenAt` and `lastSeenAt`
  - `occurrenceCount` and `recurrenceCount`
  - `affectedRefs` and `evidenceRefs`
  - `impact`, rule counters plus the `ALERT_IMPACT_KEYS`
  - `lastAlertedAt` and `lastAlertSeverity`
  - `linkedFixTaskId`
  - `acknowledgedAt` and `resolvedAt`
  - `version`, the CAS counter
- `decision_records`: the stored escalation verdict per `incident:<id>`.
- `gate_events` rows with gate `claim_loop_deferral`. Their `detail` holds `prNumber` or `blockingTaskId`, plus `consecutiveDeferrals` and `firstDeferredAt`, coalesced per (task, reason) by `recordOrCoalesceDeferral`.
- `path_claims` and `path_claim_waiters`, owned by path-claim-ownership.
- `task_dispatch_outbox` with its `dedupeKey` and `notBefore`, owned by task-dispatch-authority.

### 1.3 Existing actions this contract reuses

| Need | Existing writer |
|---|---|
| Release a holder's leases and wake its waiters | `releaseAndNotify(taskId, 'merged' \| 'abandoned' \| …)` in `apps/web/src/lib/path-claim-release.ts`. It writes the `path_claim.released` outbox intent in the same statement as the release. |
| Wake one task | `wakeTask` in `apps/web/src/lib/dispatch-authority.ts` (the outbox; the claim route still decides) |
| Run the post-merge chain | `runMergedPrWork` in `apps/web/src/lib/pr-merged-work.ts` (webhook and kernel `emit_pr_merged`) |
| Heal a missed merge webhook | `reconcileStalePrWorkers` in `apps/web/src/lib/pr-reconcile.ts` |
| Hourly stale-lease sweep | `sweepAbandonedPathClaims` in `apps/web/src/app/api/cron/maintenance/path-claims.ts` |
| Stranded-deferral notes | `sweepStrandedTasks` in `apps/web/src/lib/stranded-tasks-sweep.ts` |
| File or update the one fix task | the action layer's fix-task path (`createDbFixTaskPort`) |
| Gate and page the owner | `createGatedIncidentSender` → `notifyTeam` |
| Mark resolved or acknowledged | `updateIncidentState` with `resolve` or `acknowledge` (no caller today) |

### 1.4 Existing recovery states

There is no recovery state machine. These are the only states that exist:

- the incident `status`;
- the stored escalation verdict:
  - `owner: 'buildd'`, with an `EscalationAction` (`wait_machine`, `hold`, …) and an optional `holdUntil`;
  - `owner: 'person'`, with an `EscalationRail` (`critical_incident`, `no_next_step`);
- for the deferred task: pending, with `path_claim_waiters` rows that are notified or not notified.

§4 maps the recovery states onto exactly these. No new status value is added.

### 1.5 Reconciled with PR #4412 and workstream (a)

- **PR #4412** (merged to dev before this spec went active) added a sweep
  reconcile that resolved an open `path_overlap_stall` incident when its
  blocker PR merged or closed, or every named task left `pending`, and made a
  path-overlap stall Buildd's in the gate. Its resolve check accepted "the
  blocker merged" on its own. §7 does not: a merged blocker is the start of
  recovery, not proof of it. Workstream (a) replaced that reconcile with the
  assessment (§3) and its per-subject check, and kept #4412's other two
  properties: unknown evidence never resolves, and a path-overlap wait never
  pages the owner unless the assessment reaches `needs_decision`.
- **Workstream (a)** fixed G1 (per-blocker deferral streaks in
  `recordOrCoalesceDeferral`, one collector entry per (task, blocker), only a
  task's newest episode can be a stall, `FAILURE_PATTERN_DETECTOR_VERSION`
  `fps-v2`), G2 (a delivered `path_claim.released` wake counts as progress),
  G3 (the assessment resolves on a passing check), G4 (the fingerprint carries
  generation and state; any assessment change re-gates; Home ignores a person
  verdict the current assessment contradicts), G6 (`reconcileStalePrWorkers`
  calls `releaseAndNotify(..., 'merged')`) and G7 (deferral `detail` carries
  `blockingTaskId` and up to 20 overlapping `paths`). G5 and G9 belong to
  workstream (b). G8 (`checkStarvation`) is untouched.

---

## 2. The case this is written against, and the gaps it exposed

### 2.1 Live evidence (2026-10-11)

A High, Open incident read *"task(s) deferred on path overlap behind PR #4386 with
no progress"*. It showed one affected task, `4704311e`, and claimed the stall
was first seen about a day earlier. What actually happened, from the task's gate
history, its dispatch rows and GitHub:

- **Task `4704311e`.** It was created two days before the report. Over that time it
  was repeatedly deferred on `path_overlap`. It was woken each time a holder
  released (one `path_claim.released` dispatch row per release, all
  delivered), and each time its next poll found another overlapping open PR.
- **PR #4386.** It was opened late on 2026-10-10 UTC. The streak of deferrals
  behind it began at about 02:50 UTC on 2026-10-11, after a `stranded` row
  had interrupted the previous streak, and lasted under twenty minutes.
- **The merge.** #4386 merged at 03:08 UTC. Within seconds its claim was
  released, the task was woken and claimed, and two minutes later it completed
  with its own PR (#4396).
- **Result.** The overlap resolved itself, through the existing machinery, at
  the moment the blocker landed.
- **The incident's age was wrong.** It dated the stall to before #4386 existed.
- **The incident stays open.**
  - No code path resolves a `path_overlap_stall` incident.
  - The task will not produce another occurrence under this signature.
  - The stored verdict is the person's (`no_next_step`, because a high incident
    has no fix task) and will not be re-gated.
  - So the incident stays Open, with a Needs You card saying nothing is fixing
    it, until someone resolves it by hand.
  - The incident row itself could not be read: MCP `list_incidents` refused the
    worker token. This conclusion follows from the code paths above.

### 2.2 Gaps (each one is a defect, not a missing feature)

- **G1. Streaks for different blockers are merged into one.**
  - `recordOrCoalesceDeferral` keeps `firstDeferredAt` across a change of blocker, because it coalesces by (task, reason) only. Each poll overwrites `prNumber` with the current blocker.
  - The sweep's collector (`dbCollectFacts` in `failure-pattern-sweep.ts`) then takes the minimum `firstDeferredAt` over every row in its 24-hour window, and the newest row's blocker.
  - `rulePathOverlapStall` therefore charges the whole wait to whichever PR blocks last.
- **G2. "Progress" means only that a worker was created.**
  - `lastProgressAt` is the latest worker `createdAt` for the task.
  - A delivered wake, a release, or a change of blocker does not count as progress.
- **G3. Nothing resolves a sentinel incident.** `resolve` has no caller. An incident whose pattern stopped occurring stays Open forever.
- **G4. The verdict is stale.**
  - The stored escalation verdict is rewritten only when `claimIncidentAlert` claims a page.
  - Home reads the newest stored verdict without checking it against current state.
- **G5. The reason text is lost.**
  - `verdictFromCode` rebuilds the reason from the shared rail wording. So Home shows the generic PR sentence for `no_next_step` ("…the reviewer raised nothing to weigh…"), not anything about the incident.
  - The page says *Nothing is fixing it.* even while the claim and wake machinery is doing exactly that.
- **G6. Healing a missed merge does not release paths.** `reconcileStalePrWorkers` stamps the merge but never calls `releaseAndNotify`. Waiters on a healed PR wake only through one of:
  - the kernel's `emit_pr_merged`,
  - the hourly `sweepAbandonedPathClaims`,
  - their own next poll.
- **G7. The overlapping paths are not recorded.**
  - Deferral `detail` names the blocker but not the paths.
  - Only `path_claim_waiters.blocked_path`, and an explicit-claim diagnostic, carry them.
- **G8. The starvation check is dead code.** `checkStarvation` in `packages/core/path-claim.ts` has no callers.
- **G9. Navigation and read access are broken.**
  - The incident page's back link goes to an operator-only page, which is a 404 for everyone else.
  - `list_incidents` answers 401 to a worker token.

---

## 3. The recovery assessment (contract v1)

One assessment per incident, kept up to date. Shape (JSON, `v: 1`):

```
recovery: {
  v: 1,
  generation: number,          // bumps on every change of cause, subject set or blocker set, and on reopen
  cause: { reasonCode: string, rule: FailureIncidentRule,     // e.g. 'path_overlap.blocker_open'
           ownership: 'workflow' | 'infrastructure' | 'person' },   // §16: classified before anyone is asked
  subjects: Array<{ kind: 'task' | 'pr' | 'worker', id: string }>,   // bounded like affectedRefs
  blockers: Array<{ kind: 'pr' | 'task' | 'lease', id: string, state: string, observedAt: string }>,
  overlappingPaths: string[],   // bounded (≤ 20), path-overlap family only; [] when unknown
  observation: { observedAt: string, source: 'sweep' | 'merge_hook' | 'release_hook' | 'click' | 'backstop',
                 evidenceRevision: string },   // hash of the facts read; same facts → same revision
  firstSeenAt: string,          // this episode's start (§5 rule 3), not the incident's
  lastSeenAt: string,
  lastProgressAt: string | null,  // newest of: worker created, wake delivered, blocker changed, blocker state moved
  owner: 'buildd' | 'operator' | 'person',     // 'operator': §16
  state: 'observing' | 'recovering' | 'waiting' | 'needs_decision' | 'needs_operator' | 'inconclusive' | 'recovered',
  nextAction: { kind: string, label: string, key: string } | null,   // what Buildd does next, or asks
  nextCheckAt: string | null,     // required unless state is 'recovered' or owner is 'person'
  decision?: { question: string, options: Array<{ capability: string, label: string, effect: string }>,
               recommended: string },
  verification: { predicate: string, params: Record<string, unknown> },   // §6
  budget: { spent: number, limit: number, deadlineAt: string, spentKeys: string[] },   // spentKeys bounded, current generation only
  capabilityGap?: { capability: string, reason: string },   // operator-owned only (§16)
  attempts: Array<{ key, action, subject, at, generation }>,  // repairs actually run, all generations, bounded (20); never rewritten
}
```

- **Where it is stored.** It goes in a new nullable `recovery` jsonb column on
  `failure_incidents`, written only through the existing CAS on `version` in
  `failure-incident-store.ts` (a new `assess` member of `IncidentStateAction`).
  This is the **only migration** this mission needs: one additive, nullable
  column with no backfill. A NULL assessment means "not assessed yet" and reads
  as `observing`.
- **Why it needs a column.**
  - The assessment and the incident's `status` must change in one
    compare-and-swap. Otherwise an incident can show "recovered" while still
    Open, or the reverse, and neon-http has no transactions to bridge two rows.
  - `impact` is typed as numbers only. Overloading it would break
    `ruleImpact` and the alert keys.
  - `system_cache` and `decision_records` are separate rows, which brings back
    the same two-row problem.
  - `workflow_effects` needs a delivery (one PR's workflow) and a transition,
    and an incident has neither.
- **The verdict stays where it is.** The escalation verdict stays in
  `decision_records`. Its fingerprint (`incidentFingerprint`) MUST include
  `recovery.generation` and `recovery.state`, so a new assessment is a new look
  for the gate (fixes G4).
- **The cause becomes more precise.** `cause.reasonCode` refines the rule's
  `reasonCode`: `path_overlap.no_progress` becomes `path_overlap.blocker_open`,
  `.blocker_merged_unreleased`, `.blocker_stuck`, `.cycle`, `.subject_exempt_violated`
  or `.spurious_overlap`. The incident's own `reasonCode` column is unchanged.

---

## 4. State mapping (no new status values)

| `recovery.state` | `failure_incidents.status` | Stored escalation verdict | Needs You | Push |
|---|---|---|---|---|
| `observing` (no assessment yet) | `open` | none, or Buildd `hold` | no | no |
| `inconclusive` | `open`, never `resolved` | Buildd `hold`, `holdUntil = nextCheckAt` | no, until the budget deadline | no |
| `recovering` | `open` | Buildd `wait_machine`, with the repair named in `nextAction` | no | no |
| `waiting` (on a live blocker) | `open` | Buildd `hold`, `holdUntil = nextCheckAt` | no | no |
| `needs_decision` | `open` | person, rail `no_next_step` (or `critical_incident`) | yes, once | once per generation |
| `needs_operator` (§16) | `open` | Buildd `hold`, reason names the capability gap | no | no; the gap goes to the operator through `reportOps` |
| *(person dismissed it)* | `acknowledged` | whatever the verdict was; not re-paged unless severity rises | no | no |
| `recovered` | `resolved` (`resolvedAt` set) | Buildd `hold` ("Resolved, nothing to do.") | no | no |

Rules:

- `critical` keeps today's rule (`incidentEscalationRule`): the owner is told
  once, whatever the recovery state is.
- `needs_decision` is the **only** state that reaches a person.
- A high incident goes to a person when the budget is spent, the deadline has
  passed, or the policy says only a person can decide (§5). It no longer goes
  there just because there is no fix task.
- Today's `no_next_step` rail stays the code, but its words come from the
  assessment (§9).

---

## 5. Reconcile before acting: the general rules

1. **Re-observe before every action.**
   - Every repair and every person action re-reads its blockers and subjects
     from their owners: the `workers` PR columns, `path_claims`, the task row,
     and GitHub when the PR row is stale.
   - It then compares the fresh evidenceRevision with the stored one. If they
     differ, the action is not taken. Instead a new assessment is written,
     bumping `generation` if the cause or subjects changed.
2. **Inconclusive is not resolved.**
   - A read that fails, times out or returns partial data gives
     `inconclusive`, never `recovered`.
   - The same applies to an assessment older than 2× the sweep cadence
     (60 minutes) with no new observation.
   - No surface shows "fixed", "resolved" or a green state for `inconclusive`.
3. **Episodes are per blocker.**
   - An episode is the time a subject has waited on one specific blocker.
   - Deferral age, `firstSeenAt` and the budget deadline are measured per
     (subject, blocker) episode.
   - A change of blocker ends one episode and starts the next (fixes G1).
4. **Only the claim route schedules.**
   - Recovery never claims, starts or orders a task. It acts only through the
     writers in §1.3, the outbox and the kernel's own commands.
   - This keeps task-dispatch-authority invariants 5 and 12.
5. **One owner of each fact.**
   - Recovery reads PR state from the PR projection and the kernel. It reads
     leases from `path_claims`.
   - It never writes a lifecycle field, a lease, a kernel state or an outbox
     row except through the writer that owns it.

## 6. Path-overlap recovery policy (the 8 points)

The policy is evaluated in order for each (subject task, blocker) episode, on
fresh observation (§5 rule 1). The first rule that matches decides the
assessment.

1. **The subject is no longer stuck.**
   - It has started a worker since the episode began, has reached a terminal
     status, or has had no `path_overlap` deferral since `observedAt`.
   - Result: the subject's part of the check passes. When every subject passes,
     the state becomes `recovered` (§7).
2. **The blocker merged or closed, but its leases are still held or a waiter
   was never notified (G6).**
   - Action `release_blocker`: call `releaseAndNotify(blockerTaskId, 'merged' | 'abandoned')`.
     It is idempotent, and its outbox write wakes the waiters.
   - State: `recovering`. nextCheckAt is now + 2 minutes.
3. **The blocker is gone, but the subject is still pending and was never woken
   in this episode.**
   - Action `wake_subject`: call `wakeTask(subjectId, 'path_claim.released')`,
     at most once per generation.
   - State: `recovering`.
4. **The blocker is open and moving.**
   - "Moving" means its kernel delivery is non-terminal and not `ESCALATED`,
     with a transition, CI run or push since the last check.
   - State: `waiting`, owner Buildd, `nextAction` "wait for PR #N to land".
   - nextCheckAt is the blocker's next expected event, otherwise the backoff
     in §8.
   - The blocker's merge triggers a reassessment straight away, through the
     merge hook in §12(a). The backstop is not the main path.
5. **The blocker is open and stuck.**
   - "Stuck" means its delivery is `ESCALATED`, it has a person verdict of its
     own, or it has made no progress past the episode deadline.
   - Recovery MUST NOT create a second card. The incident's assessment points
     at the blocker's own escalation (`nextAction.kind = 'blocked_by_escalation'`,
     linking the PR's Needs You item), and the incident's owner stays Buildd.
   - The person sees one card, the blocker's, with the subject listed as also
     waiting on it.
6. **There is a cycle.**
   - The blocker's repair attempt `dependsOn` the subject, or the waiter chain
     returns to the subject. This is the known deadlock: waiting cannot help.
   - State: `needs_decision` at once, with typed options: cancel the stale
     attempt, narrow the subject's manifest to its declared paths, or wait (the
     last only with a reason).
7. **The overlap is spurious.**
   - The blocker's actual PR diff does not touch `overlappingPaths`, because its
     `pathManifest` grew larger than the diff.
   - Recovery records the cause `path_overlap.spurious_overlap`. If no fix task
     exists, it files one through the existing fix-task path.
   - It offers the person the typed action "narrow the blocker's manifest to its
     diff", applied through the existing narrow writer. It never overrides the
     claim route.
8. **The subject is exempt but still deferred.**
   - The subject's anchor names the blocker PR (`subjectPrNumber`), yet it is
     still being deferred.
   - This is a platform defect: cause `path_overlap.subject_exempt_violated`.
   - Recovery files or updates the one fix task. The state is `recovering` with
     owner Buildd while that task runs. It becomes `needs_decision` only when the
     fix task ends without the check passing.

When none of the rules apply, the state is `inconclusive`. When the budget runs
out or the deadline passes (§8) while the state is still `recovering` or
`waiting`, the state becomes `needs_decision` with the options the last rule
offered.

**As implemented** (`evaluatePathOverlap` in
`apps/web/src/lib/failure-incident-recovery-path-overlap.ts`):

- **Evaluation order** is 1, 2, 3, 6, 8, 7, 5, 4. A cycle, an exempt subject
  and a spurious overlap are checked before "the blocker is open", because a
  blocker that is open and moving would otherwise hide them (AC-8 requires a
  cycle to decide at once).
- **Rule 1** passes when the task left `pending`, started a worker after its
  episode began, or was deferred behind a *different* blocker since (that wait
  is another incident's episode). "No deferral since the last observation" is
  not used: a task nobody polled has no deferral either, and that is not
  progress.
- **Rule 5's "no progress past the deadline"** is the rule 4 wait running into
  the episode deadline, which becomes `needs_decision`. Only an `ESCALATED`
  delivery is `blocked_by_escalation`.
- **Rule 7** reads `diffPaths`, which the sweep's observer leaves unknown (it
  makes no GitHub call), so it is dark until a diff source is wired.
- **Combining subjects:** each subject is judged on its own episode. The
  incident takes the most urgent verdict (decide, repair, operator, delegated,
  wait, inconclusive) and passes only when every subject passes and the
  incident kept a ref for every stalled task.

---

## 7. Resolution, dismissal and reopen

- **The check, path-overlap family.**
  - It passes when every subject in the assessment satisfies rule 1 of §6 on
    an observation taken at or after the last repair.
  - Each family defines its own check. It MUST be decidable from facts and
    MUST NOT be "no new occurrence lately".
- **Auto-resolution.**
  - When the check passes, one CAS writes `status: 'resolved'`, `resolvedAt`,
    `recovery.state: 'recovered'` and the evidence revision that passed.
  - The gate then re-runs, the fingerprint changes, and the verdict becomes
    Buildd's `hold`.
- **Three different events, three different effects:**
  - **The incident is resolved:** the check passed.
  - **A subject task completed:** this satisfies the check *for that subject
    only*. It never resolves the incident by itself when other subjects remain.
  - **The fix task completed:** Buildd re-assesses (the fingerprint already
    changes when the fix task stops running). It does not resolve the incident.
    A finished fix whose check still fails becomes `needs_decision`.
- **Dismissal by a person.**
  - It sets `status: 'acknowledged'` (`acknowledgedAt`) and
    `recovery.decision.chosen = 'dismiss'`.
  - The incident leaves Needs You and is not paged again unless its severity
    rises. This matches today's `planIncidentAlert` for `acknowledged`.
  - Dismissal is not resolution. The sweep keeps assessing the incident, and a
    passing check still resolves it.
- **Reopen.**
  - A fresh occurrence on a `resolved` row reopens it, as `mergeIncident` does
    today, with `recurrenceCount + 1`.
  - Reopening MUST bump `recovery.generation` and reset `budget.spent`.
  - A reopen re-gates. It pages only if the new generation reaches
    `needs_decision`, or the incident is critical.

---

## 8. Idempotency, concurrency and budgets

**Keys:**

- The assessment generation key is `recovery:<incidentId>:g<generation>`.
- The action key is `recovery:<incidentId>:<subjectKind>:<subjectId>:<causeCode>:<action>:g<generation>:a<attempt>`.
- **The action key is recorded before the action runs.** It is added to
  `recovery.budget`'s list of spent keys in the same CAS that claims the repair.
  - That CAS is the at-most-once guarantee. A writer that finds the key already
    spent does nothing.
  - The outbox does not provide this. Its pending coalescing on
    (task, `dedupe_key`) only merges wakes while a row is still pending, and
    `wakeTask` exposes no key.
  - So a wake carries the action key only as outbox metadata, through
    `enqueueTaskDispatch`, for tracing.
- **The audit row** is a `gate_events` row keyed with `recordDeferralOnce`'s
  shape.
- **Push.** The push `dedupeKey` keeps today's per-claim form, made unique by
  the generation.

**Concurrency:**

- **CAS.** Every write to an assessment is a CAS on `failure_incidents.version`.
  A writer that loses the race re-reads and re-plans from the row it read, the
  same loop as `claimIncidentAlert`.
- **Lease.**
  - A repair is claimed before it runs, in the `system_cache` key
    `failure-incident-recovery:<incidentId>`, with `expiresAt` set
    `EFFECT_LEASE_MS` (120 s) ahead.
  - The claim uses the same insert-or-update-if-expired shape as the fix-task
    claim.
  - If the holder dies, the lease expires and the next sweep takes over.
- **No duplicate repairs.**
  - At most one repair per (incident, subject, cause, action, generation) is in
    flight.
  - Concurrent triggers (the merge hook, the release hook, the sweep, a click)
    collapse onto the lease plus the action key.
  - A repair whose re-check (`nextCheckAt`, 2 minutes) is not yet due is in
    flight: a trigger that plans the same action again in that window reuses
    its key and runs nothing.
- **Order inside one call** (`assessIncident`): observe, plan, and only if a
  repair is planned, take the lease and observe again; a different evidence
  revision drops the repair and writes the fresher assessment (I-3); then one
  CAS writes the assessment with the key spent (I-4); then the repair runs.

**Default budget, backoff and deadline (proposals; per-workspace tuning is out of scope):**

| Parameter | Default | Why |
|---|---|---|
| `budget.limit` | 3 repairs per (subject, cause, generation) | Matches the kernel's 3-attempt families. A fourth identical repair is evidence that repairing does not work. |
| Backoff between checks | 5 min, then 15, then 45, capped at 2 h | Above the 2-minute trigger debounce, and below the 30-minute cron for the first two checks. |
| Episode deadline before `needs_decision` | 6 h from the episode's `firstSeenAt` | Three times the stall threshold of 120 min. Long enough for a normal PR to land; short enough not to hide a day-long stall. |
| Staleness after which an assessment is `inconclusive` | 60 min with no observation | 2× the cron cadence. |
| nextCheckAt when Buildd owns it | never null | Every Buildd-owned state promises its next look. |

---

## 9. Surfaces: one verdict, honest words, actions that re-check

**One verdict.**

- The incident page, the Home Needs You card, the nav badge count and the push
  MUST all be drawn from the same two stored facts:
  - `failure_incidents.recovery`;
  - the newest escalation verdict whose fingerprint carries the current
    `recovery.generation`.
- No surface re-derives ownership.
- A stored verdict for an older generation is treated as absent. The incident
  is not listed, and the next sweep re-gates it. Today's Home reads the newest
  verdict with no check against current state (G4).
- Push stays on the one existing path: `createGatedIncidentSender` →
  `notifyTeam`. The outbox's `incident` intent stays unregistered. No second
  notifier is added.

**Copy rules.**

- Retire *Nothing is fixing it.* and the incident use of the generic
  `no_next_step` PR sentence (G5). The sentence shown MUST say:
  - what Buildd last did, if anything;
  - what it is waiting on, if anything;
  - when it looks again, or which one choice it needs.
- Example forms, plain words, no internal identifiers beyond PR and task short ids:
  - waiting: "Waiting for PR #N to land. Buildd checks again at 14:20."
  - recovering: "PR #N landed; Buildd released its files and restarted task 1a2b3c4d."
  - inconclusive: "Buildd couldn't confirm this is still happening. It checks again at 14:20."
  - needs_decision: "Task 1a2b3c4d and PR #N's fix are waiting on each other. Choose one to stop."
  - recovered: "Recovered at 03:10: task 1a2b3c4d started once PR #N landed."
- Times are shown in the viewer's timezone, per the timezone-resolution spec.
- Ages come from the episode (§5 rule 3), never from the incident's first sighting.
- Words like "fixed", "resolved" or "recovered" appear only for `recovered`.
  `inconclusive` never uses them.
- The push text follows the same rules. It keeps today's
  structure-only constraint in `formatIncidentAlert`: no titles, signatures or
  log text.

**Typed-capability actions.**

- Each option in `recovery.decision.options` names one capability, from a closed
  set that is versioned with the assessment:
  - `dismiss`
  - `retry_recovery`
  - `cancel_attempt`
  - `narrow_subject_manifest`
  - `narrow_blocker_manifest`
  - `open_blocker`
- A click posts `{capability, generation, evidenceRevision}`. The server then:
  - re-checks the team's permission;
  - re-observes the facts (§5 rule 1);
  - applies the action only if `generation` is unchanged and the capability's
    precondition still holds.
- Otherwise it answers 409 with the fresh assessment, and the UI re-renders it
  in place of the stale one. A click never acts on a stale screen.
- The route is proposed as POST /api/health/incidents/[id]/actions (NOT
  IMPLEMENTED). It is the incident page's only write path. Its writes go through
  the writers in §1.3 and `updateIncidentState`.

---

## 10. Invariants

- I-1. An incident whose `recovery.state` is not `recovered` has `status` ≠ `resolved`, and the reverse also holds (once assessed).
- I-2. A Buildd-owned assessment always has nextCheckAt set and in the future, or is `inconclusive`.
- I-3. No repair runs without a re-observation in the same call whose evidenceRevision matches the one the repair was planned on.
- I-4. At most one repair per action key ever has an effect.
- I-5. `budget.spent ≤ budget.limit`. A repair attempted at the limit is refused, and the state becomes `needs_decision`.
- I-6. Home, the badge, the push and the page show the same owner and the same sentence for an incident at a given `version`.
- I-7. Recovery never writes `tasks.status`, `path_claims`, `workflow_deliveries` or `task_dispatch_outbox` except through the writers named in §1.3.
- I-8. A path-overlap episode's age never covers time before its blocker existed.

## 11. Acceptance criteria

- AC-1: GIVEN a task deferred behind PR A for 3 h and then behind PR B for 10 min WHEN the sweep runs THEN no path-overlap candidate for PR B has an occurrence older than PR B's first deferral, and none is created for B at all under the 120-minute threshold.
- AC-2: GIVEN an incident whose blocker PR merged and whose subject task then started a worker WHEN the merge hook or the backstop re-assesses it THEN the incident is `resolved` with `recovery.state = 'recovered'`, and it is absent from Needs You and the badge count.
- AC-3: GIVEN an open incident whose last observation is more than 60 min old and the re-read fails WHEN it is assessed THEN `recovery.state = 'inconclusive'` and `status` stays `open`.
- AC-4: GIVEN a blocker PR merged with its leases still held (missed webhook, healed by `reconcileStalePrWorkers`) WHEN recovery runs THEN `releaseAndNotify` is called once, and a second concurrent run with the same generation finds the action key already spent and calls nothing.
- AC-5: GIVEN a stored person verdict from generation 1 and an assessment now at generation 2 with state `waiting` WHEN Home loads THEN the incident is not listed.
- AC-6: GIVEN `budget.spent = 3` for a (subject, cause) WHEN a fourth repair is planned THEN no repair runs, and the state is `needs_decision` with a non-empty `decision.options`.
- AC-7: GIVEN a person clicks `cancel_attempt` on generation 2 WHEN the incident is already at generation 3 THEN the action route answers 409 with the generation-3 assessment and nothing is cancelled.
- AC-8: GIVEN a cycle (the blocker's repair attempt depends on the subject) WHEN assessed THEN the state is `needs_decision` straight away, without waiting for the deadline.
- AC-9: GIVEN a blocker whose kernel delivery is `ESCALATED` WHEN assessed THEN the incident stays Buildd-owned with `nextAction.kind = 'blocked_by_escalation'`, and Home shows exactly one card (the PR's).
- AC-10: GIVEN a dismissed (`acknowledged`) incident whose check later passes WHEN assessed THEN it becomes `resolved`. GIVEN instead a new occurrence at the same severity THEN no page is sent.
- AC-11: GIVEN any incident page, Home card or push for a non-`recovered` incident THEN the text contains none of "Nothing is fixing", "fixed" or "resolved".
- AC-12: GIVEN a `resolved` incident that receives a fresh occurrence WHEN upserted THEN `recurrenceCount` increments, `recovery.generation` increments and `budget.spent` is 0.

---

## 12. Workstreams for follow-on tasks

Every path below exists today, unless it is marked *new*.

### (a) Backend: assessment, path-overlap recovery, merge-triggered reconcile, sweep backstop

Shipped (§1.5). The optional `EscalationAction` additions were not needed: a
repair records as `wait_machine` with the assessment's own sentence.

- **Migration.** `packages/core/db/schema.ts` gets `failure_incidents.recovery`
  jsonb, nullable. Generate the migration with `bun db:generate`. Check the next
  free index against `origin/dev` first: this mission branch can lag dev.
- **Types.**
  - `packages/shared/src/types.ts`: the assessment v1 type, and `FailureIncident` gains `recovery`.
  - `packages/core/escalation-gate.ts`: no new rail. Optionally add a Buildd action for `release_blocker` and `wake_subject` to `EscalationAction` and `ACTION_WORDS` (a type-only change).
- **Ledger.** `apps/web/src/lib/failure-incident-store.ts`:
  - an `assess` action in `IncidentStateAction`;
  - `recovery` in the port mapping;
  - `mergeIncident` bumps the generation and resets the budget on reopen.
- **Assessment and policy** (new files):
  - `apps/web/src/lib/failure-incident-recovery.ts`: the pure assessment, the state mapping, budget and backoff, and a port for re-observation.
  - `apps/web/src/lib/failure-incident-recovery-path-overlap.ts`: the 8 rules of §6.
  - Co-located tests for both.
- **Fix G1 and G2 (facts):**
  - `packages/core/gate-events.ts`: in `recordOrCoalesceDeferral`, start a new streak when `detail.prNumber` or `detail.blockingTaskId` changes, or keep a per-blocker blockerFirstDeferredAt.
  - `apps/web/src/app/api/workers/claim/route.ts`: add bounded `paths` to the deferral detail in `deferTask` (G7).
  - `apps/web/src/lib/failure-pattern-sweep.ts`: one entry per (task, blocker), and `lastProgressAt` includes delivered wakes.
  - `apps/web/src/lib/failure-pattern-sentinel.ts`: `rulePathOverlapStall` reads the per-blocker episode. Bump `FAILURE_PATTERN_DETECTOR_VERSION`, because the signature semantics change.
- **Gate.** `apps/web/src/lib/failure-incident-escalation.ts`:
  - `incidentFingerprint` includes the generation and the state;
  - `incidentEscalationRule` takes the recovery state into account (§4);
  - the sweep re-gates on any assessment change, not only when a page is claimed (G4).
- **Merge-triggered reconcile:**
  - `apps/web/src/lib/pr-merged-work.ts`: after `releaseAndNotify`, re-assess the open incidents that name the PR.
  - `apps/web/src/lib/pr-reconcile.ts`: `reconcileStalePrWorkers` calls `releaseAndNotify(..., 'merged')` when it heals a merge (G6).
- **Backstop.**
  - `apps/web/src/lib/failure-pattern-sweep.ts`: after detection, re-assess the open incidents whose `nextCheckAt ≤ now` or whose assessment is stale.
  - The existing cron route `apps/web/src/app/api/cron/failure-pattern-sentinel/route.ts` runs it, so no new cron is added.
  - Optionally wire `checkStarvation` here or delete it (G8).
- **Tests.**
  - `apps/web/src/lib/failure-incident-store.test.ts`
  - `apps/web/src/lib/failure-incident-escalation.test.ts`
  - `apps/web/src/lib/failure-pattern-sweep.test.ts`
  - `apps/web/src/lib/failure-pattern-sentinel.test.ts`
  - `packages/core/__tests__/` for gate-events
- **Closing step.** Promote this spec to `active` and set `last_verified`.

### (b) Shared UI projection: page, Home Needs You count, push

- **Projection.** `apps/web/src/lib/incident-view.ts` gets one projection function that turns (incident, recovery, verdict) into {owner, state word, sentence, next check, options}. Every surface below uses it.
- **Page.** `apps/web/src/app/app/(protected)/incidents/[id]/page.tsx`:
  - replace the Fix section's fallback with the projection;
  - render typed options;
  - fix the back link (G9).
- **Action route.** Add `apps/web/src/app/api/health/incidents/[id]/actions/route.ts` (*new*) with a co-located `route.test.ts`. It is the click-time re-check of §9.
- **Home and badge.**
  - `apps/web/src/lib/failure-incident-escalation.ts`: `loadIncidentNeedsYou` and `incidentNeedsYouItems` filter by generation and take the sentence from the projection.
  - `apps/web/src/lib/home-attention.ts`: the `incident` case.
  - `apps/web/src/lib/action-queue.ts`: the INCIDENT chip text.
- **Push.** `apps/web/src/lib/failure-incident-actions.ts`: `formatIncidentAlert` uses the projection sentence.
- **Proof.** Screenshots at 390 px and at desktop width, in both themes, through `visual-qa.yml` (see `/visual-review`). Cover the page states `waiting`, `needs_decision`, `inconclusive` and `recovered`, plus the Home card.

### (c) End-to-end verification and regression

- **Tests.**
  - Extend `apps/web/src/lib/failure-pattern-sentinel.e2e.test.ts`.
  - Add `apps/web/tests/db/failure-incident-recovery.test.ts` (*new*, real Postgres).
- **The scenario: a stale blocker like #4386.**
  1. Task T is deferred behind PR A, then behind PR B.
  2. B merges. The run checks AC-1 (no inflated age), AC-4 (release once) and AC-2 (resolved; gone from Home).
  3. It then replays a missed merge webhook through `reconcileStalePrWorkers` and asserts the same outcome.
- **Also covered:** AC-3, AC-5, AC-7, AC-11 and AC-12, against the projection and the action route.

### Dependency DAG

```
(a) backend ──► (b) UI projection ──► (c) end-to-end verification
     └────────────────────────────────►┘
```

- (b) needs (a)'s stored `recovery` field and the fingerprint change. Its
  projection and action route read them.
- (c) needs both (a) and (b), because AC-5, AC-7 and AC-11 cover the projection.
- (a) and (b) both edit `failure-incident-escalation.ts`, so they MUST NOT run
  in parallel.
- Inside (a), the migration and the type change come first.

## 13. Coordination

- **UI cohesion mission `6df96409`.** It owns state words, card shape and copy
  tone. Workstream (b) uses its vocabulary and primitives and adds no incident
  variants of its own. The copy rules in §9 constrain only *what* is claimed,
  not the visual form.
- **Execution control plane mission `27b1fe42`.** It owns which host drains
  effects and runs crons. Recovery adds no drain, no scheduler and no host of
  its own. It runs inside the existing sentinel sweep, the merge hook and the
  action route, so it moves with them.
- **Things this mission must not create:**
  - a second incident service or table;
  - a second lifecycle writer for tasks, leases or deliveries;
  - a second scheduler, since the claim route stays the only one;
  - a second notification path, since `notifyTeam` through the gate stays the
    only one.

## 14. Code surface

- `apps/web/src/lib/failure-incident-recovery.ts`: `planRecovery`, `assessIncident`, `assessDueIncidents`, `recoveryDue`, `evidenceRevision`, `recoveryActionKey`, `RecoveryFamily`, `RecoveryEffects`, `productionRecoveryEffects`, `claimRecoveryLease`, `RECOVERY_BUDGET_LIMIT`, `RECOVERY_BACKOFF_MINUTES`
- `apps/web/src/lib/failure-incident-recovery-path-overlap.ts`: `evaluatePathOverlap`, `dbObservePathOverlapRecovery`, `pathOverlapRecoveryFamily`
- `packages/shared/src/types.ts`: `FailureIncidentRecovery`, `FailureRecoveryState`, `FailureRecoveryOwner`, `FailureCauseOwnership`, `FailureRecoveryCapability`
- `apps/web/src/lib/failure-pattern-sentinel.ts`: `detectFailurePatterns`, `rulePathOverlapStall`, `DEFAULT_SENTINEL_THRESHOLDS`, `FAILURE_PATTERN_DETECTOR_VERSION`
- `apps/web/src/lib/failure-pattern-sweep.ts`: `runFailurePatternSweep`, `SWEEP_LOOKBACK_MINUTES`, `reassessIncidentsNamingPr`, `regateAlert`
- `apps/web/src/lib/failure-incident-store.ts`: `upsertIncident`, `mergeIncident`, `updateIncidentState`, `applyIncidentAction`, `createDbIncidentPort`
- `apps/web/src/lib/failure-incident-actions.ts`: `actOnIncidentResults`, `claimIncidentAlert`, `planIncidentAlert`, `formatIncidentAlert`, `incidentDeepLink`
- `apps/web/src/lib/failure-incident-escalation.ts`: `incidentEscalationRule`, `incidentFingerprint`, `incidentSubjectRecovery`, `createGatedIncidentSender`, `loadIncidentNeedsYou`, `incidentNeedsYouItems`, `loadIncidentVerdicts`
- `packages/core/escalation-gate.ts`: `EscalationVerdict`, `verdictCode`, `verdictFromCode`
- `packages/core/gate-events.ts`: `recordOrCoalesceDeferral`, `recordDeferralOnce`
- `packages/core/path-claim.ts`: `releaseClaims`, `registerClaimDeferralWaiters`, `checkStarvation`
- `packages/core/path-overlap.ts`: `boundDeferralPaths`, `MAX_DEFERRAL_PATHS`
- `apps/web/src/app/api/workers/claim/route.ts`: the `path_overlap` deferral `detail` (`blockingTaskId`, `paths`)
- `apps/web/src/lib/path-claim-release.ts`: `releaseAndNotify`
- `apps/web/src/lib/pr-merged-work.ts`: `runMergedPrWork`
- `apps/web/src/lib/pr-reconcile.ts`: `reconcileStalePrWorkers`
- `apps/web/src/lib/dispatch-authority.ts`: `wakeTask`
- `apps/web/src/lib/home-attention.ts`: `resolveQueueAttention`
- `apps/web/src/app/app/(protected)/incidents/[id]/page.tsx`, `apps/web/src/lib/incident-view.ts`: `incidentStateLine`
- `packages/core/db/schema.ts`: `failureIncidents`, `decisionRecords`, `gateEvents`

## 15. Out of scope

- `trunk_incidents` and the kernel's trunk recovery (workflow-state-kernel §6.10).
- Recovery policies for the other seven rules. They implement §3–§8 in later
  missions. This spec fixes only the contract they must meet.
- Per-workspace tuning of the §8 defaults.
- Registering an adapter for the outbox's `incident` intent.
- Changing who may merge, or any rule of the PR escalation gate.

---

## 16. Infrastructure failures must not become a person's question

*Owner scope amendment, 2026-10-11.* The contract above extends to failures in
Buildd's own machinery that today reach a person as a generic question. Status:
**NOT IMPLEMENTED** beyond the shared types (`cause.ownership`, owner
`operator`, state `needs_operator`, `capabilityGap`, which `planRecovery`
already handles). The delivery tasks are listed in §16.7.

### 16.1 The case

A surface-audit task in an MCP connection mission (`7d3ff681`, mission
`9bca3364`) dispatched `visual-qa.yml` to capture screenshots. The workflow's
database scrub step failed on the `artifact_revisions` immutability trigger, so
the app never booted and no screenshot existed. The auditor followed its
prompt's "Boot failure" section and asked the owner "How should I proceed?",
offering options it made up (sync dev, capture dev, cancel). No person's
decision could fix a failing scrub, and "capture dev" would have substituted
evidence from a different revision.

Gaps, against the code:

- **H1. No classification.** A failed `visual-qa.yml` run is only a failed run.
  `classifyPageLoad` (`packages/core/visual-qa-page-source.ts`) types the two
  preview auth walls and nothing else; scrub, guard, migration, clone and
  browser failures have no code.
- **H2. The prompt turns every capture failure into a question.** The auditor
  role's "Boot failure" section (`apps/web/src/lib/default-roles.ts`) tells it
  to call `AskUserQuestion`, whatever failed.
- **H3. The question carries no cause.** `workers.waitingFor` holds prompt and
  options only. Nothing reconciles it when the infrastructure is repaired;
  `cleanupStuckWaitingInput` only ages it out.
- **H4. Exhaustion has one exit.** When retries run out, the only route is the
  question, so "retry exhaustion" invents a human decision.
- **H5. The mission cannot say why.** Mission progress shows the audit as
  running or waiting on the owner, not as blocked by a repair.

### 16.2 Classify cause and ownership before asking anyone

Every failure that would produce a `waiting_input` question or a Needs You card
is classified first, into `cause.ownership`:

| Ownership | Meaning | Examples | May ask a person? |
|---|---|---|---|
| `infrastructure` | Buildd's own machinery or environment failed; no workspace person's decision fixes it | QA clone, scrub, guard, migration on the clone, browser launch, runner sandbox, a credential Buildd holds | **No.** Repair, then operator (§16.4) |
| `workflow` | Coordination between Buildd's own work items | path overlap (§6), retry forks, stale leases | Only through `needs_decision` with typed options (§4) |
| `person` | A decision only an authorized person can make | the workspace's merge policy, a product choice, the preview auth walls `protection_bypass_missing` / `app_auth_not_configured` (owner setup), approving a destructive action | Yes: one concrete typed capability |

Unknown ownership is explicit (`inconclusive`), never defaulted to `person`.

### 16.3 The family: `infrastructure_failure`

- **Rule and signature.** A new `FailureIncidentRule`, `infrastructure_failure`,
  with signature `infrastructure_failure|ws=<id>|component=<component>|sig=<friction signature>`.
  The friction signature is the normalized error (`toFrictionSignature`). So
  every audit blocked by the same failing scrub statement is a subject of ONE
  incident, and that incident files ONE fix task.
- **Components (closed set, v1):** `visual_qa.clone`, `visual_qa.migrate`,
  `visual_qa.scrub`, `visual_qa.guard`, `visual_qa.boot`, `visual_qa.browser`.
- **Facts.** It is opened from a typed capture failure
  `{ component, runId, step, errorSignature, ref, headSha }`, reported by the
  capture path instead of a question (§16.5). Subjects are the blocked tasks
  (`kind: 'task'`) and their missions (`kind: 'mission'`).
- **Policy, in order:**
  1. **Check passes.** A capture of the same component, on a run started after
     the last repair, for the subject's own ref and head, succeeded. The state
     becomes `recovered`, and the resume adapter runs (§16.4).
  2. **No fix task.** Repair `file_fix_task`, once per generation, through the
     existing fix-task path (`createDbFixTaskPort`, claim key
     `failure-incident-fix:<id>`).
  3. **Fix task running.** `delegated`, `fix_task_running`.
  4. **Fix task finished, check not re-run.** Repair `retry_capture`: re-queue
     the blocked audits through the resume adapter. Bounded by `budget.limit`
     (3) per generation.
  5. **Budget spent or deadline passed.** `needs_operator`, with `capabilityGap
     { capability: 'repair_infrastructure:<component>', reason }`. Not
     `needs_decision`: exhaustion alone does not create a person's decision.
     The gap goes to the operator over `reportOps`. The buildd-admin operator
     recovery queue (operator-recovery spec, buildd-admin) reads it from there.
  6. **A concrete authorized decision exists.** Only if the policy names a
     typed capability only a workspace person holds (none exists in v1; waiving
     the mission's surface audit is one candidate, and it is the person's call
     to make, never recovery's) is the state `needs_decision`.

### 16.4 Adapters to tasks and missions (no second lifecycle writer)

- **Task adapter.** Each blocked task gets `context.recoveryRef = { incidentId,
  generation }`, written through the existing context merge (the fix-task
  port's `touch` shape). Task surfaces read the incident's assessment through
  it. They never parse the question text.
- **Stale question.** Once a blocked task has a `recoveryRef`, its worker's
  open `waiting_input` question is superseded. It is closed through the
  existing waiting-input cleanup writer (`cleanupStuckWaitingInput` in
  `apps/web/src/lib/stale-workers.ts`) with reason `superseded_by_recovery`.
  The worker row, its question and its attempt stay as history.
- **Resume.** When §16.3 rule 1 passes, each blocked task goes back to
  `pending` through the existing requeue writer and is woken with
  `wakeTask(taskId, 'task.requeued')`. The claim route decides when it runs.
- **Mission adapter.** The audit obligation stays where it is
  (`evaluateSurfaceAuditGate`). A required audit whose task carries a
  `recoveryRef` reads "Audit blocked: <component> repair <state>". It stays
  unmet: completion progress never counts it as done.
- **Rollout and periodic reconciliation.** The existing sentinel cron
  reconciles legacy open states. It looks at every `waiting_input` worker on a
  surface-audit task whose run has a typed capture failure. The run's failing
  step is read from the Actions API through the existing GitHub client. A
  legacy question with no such record stays as it is, marked unclassified, and
  is never auto-answered. Unknown stays explicit.

### 16.5 The capture path reports, it does not ask

- **Capture path.** `scripts/qa/capture.ts` and the `visual-qa.yml` steps emit
  `{ component, step, errorSignature }` for a failure, in the
  `qa-screenshots` artifact's manifest.
- **Auditor.** The auditor role's "Boot failure" section reports that object
  through its existing progress and completion path (a structured
  capture-failure field (proposed)). It does not call `AskUserQuestion`.
- **The person's question is kept** for the two preview auth walls, which are
  owner setup (§16.2), with typed options.

### 16.6 Invariants and acceptance

- I-9. No `waiting_input` question and no `needs_decision` is produced for a cause whose ownership is `infrastructure` or `workflow`, unless the policy names a typed capability only a person holds.
- I-10. One incident, and so at most one fix task, per (workspace, component, error signature). N blocked audits are N subjects of it.
- I-11. Recovery never marks an audit passed, waives it, cancels or deletes a task, worker, question or attempt.
- I-12. A blocked audit resumes only after the check passes on a capture run started after the last repair, for its own ref and head. Evidence from another revision or branch never satisfies it.
- AC-13: GIVEN two surface-audit tasks whose captures fail on the same scrub statement WHEN both report THEN one `infrastructure_failure` incident exists with both tasks as subjects, one fix task is filed, and neither worker is in `waiting_input`.
- AC-14: GIVEN the fix task merged and a later capture of the same component succeeds for each audit's own head WHEN assessed THEN the incident is `recovered` and each audit task is `pending` and woken once, with its earlier attempts and question kept.
- AC-15: GIVEN three `retry_capture` repairs that all failed WHEN a fourth is planned THEN none runs, the state is `needs_operator` with a `capabilityGap`, no Needs You card exists, and one `reportOps` warning was sent.
- AC-16: GIVEN a legacy `waiting_input` audit question with no typed capture failure on record WHEN the rollout sweep runs THEN the question is unchanged and marked unclassified.
- AC-17: GIVEN a capture that hits `app_auth_not_configured` WHEN classified THEN ownership is `person`, and the question offers the typed owner-setup action, not retry or cancel.

### 16.7 Delivery

These are dependent builder tasks in this mission. Each one claims its paths
before editing. The overlap with the control-plane mission (`27b1fe42`, which
hosts crons and drains) and the automatic visual-review mission (which owns
the auditor role and capture) is coordinated through those path claims.

1. Task `b3cb321d`. Repair the scrub itself: `scripts/qa/scrub-pii.sql` must run under the
   `artifact_revisions` immutability trigger (the concrete failure in §16.1).
2. Task `89d92f1a`. Typed capture failures, plus the auditor prompt: §16.5, H1, H2.
3. Task `1acc6048`. The `infrastructure_failure` family on this contract, with the task and
   mission adapters and rollout reconciliation: §16.3, §16.4, H3–H5.

---

## 17. Surface and state matrix

Every surface reads ONE canonical assessment, through an adapter: the
incident's `recovery`, or a task's or mission's `recoveryRef` to it. No
surface derives state from question text, a string match on errors, or its own
heuristics. Workstream (b) and the §16 tasks deliver this matrix. Today only
the gate column is wired (§1.5).

### 17.1 What each state shows

| State | Status word | Owner shown | Question controls | Counts in Needs You and badge | Global banner |
|---|---|---|---|---|---|
| `observing` | Checking current status | Buildd | no | no | no |
| `recovering` (repair queued or running) | Repair queued / Repair running, plus what the repair is | Buildd | no | no | no |
| `recovering` (retry n of 3) | Retrying (n of 3) | Buildd | no | no | no |
| `waiting` | Waiting for PR #N / for task X, plus next check time | Buildd | no | no | no |
| `inconclusive` | Couldn't confirm, plus next check time | Buildd | no | no | no |
| `needs_operator` | Automatic recovery unavailable: reason, and the operator action | Operator | no | no | no; the operator gets it over `reportOps` |
| `needs_decision` | The one question, with typed options | Person | yes, typed capabilities only | yes, once | yes, while unanswered |
| `recovered` / superseded | Recovered at HH:MM: what moved | n/a | no | no, removed after reconciliation | no |

Copy rules are those of §9. "Fixed", "resolved" and "recovered" appear only for
`recovered`. Diagnostics, raw ids, paths and attempt history live in
expandable details on every surface.

### 17.2 Surfaces and their adapter

| Surface | Reads | Must not |
|---|---|---|
| Global attention banner | incident / `recoveryRef` → §17.1 | show a banner for any state but `needs_decision` |
| Home Needs You | `incidentNeedsYouItems` (generation-checked) and task questions via `recoveryRef` | list a question superseded by recovery |
| Nav badge / count | same rows as Home Needs You | count anything Home does not list |
| Mission list, detail, header, progress | mission adapter (§16.4) | show RUNNING or done for an audit blocked by a repair |
| Task list, detail, mobile task sheet | task adapter (`recoveryRef`) | offer question controls for a superseded question |
| Activity / chat cards and question forms | task adapter | render "How should I proceed?" for a system failure |
| Incident detail | incident `recovery` + generation-matched verdict | say "Nothing is fixing it" |
| Notifications / push | `createGatedIncidentSender` → `notifyTeam` only | send for any state but `needs_decision` or critical |

### 17.3 Verification matrix

Each case is covered on every surface in §17.2. Tests assert the state and the
owner. Screenshots at 390 px and desktop width, in both themes, through
`visual-qa.yml`, prove the rendering (workstream (b)).

| Case | Fixture | Expected on every surface |
|---|---|---|
| stale prompt (pre-recovery question, recovery now owns it) | legacy `waiting_input` + `recoveryRef` | question gone from banner, Home, badge, cards; history kept |
| repairing | `recovering`, `file_fix_task` / `release_blocker` | "Repair running" with owner Buildd and next check |
| retry exhausted | `needs_operator` | "Automatic recovery unavailable" with the gap; not in Needs You |
| genuine decision | `needs_decision` (cycle, AC-8) | one card, typed options, push once |
| inconclusive | failed read (AC-3) | "Couldn't confirm", next check, no green |
| recovered | check passed (AC-2, AC-14) | gone from banner, Home and badge; incident page says recovered |
