---
title: Subject Anchor Liveness
status: active
owner: max
last_verified: 2026-08-29
supersedes: []
---

## Subject Anchor Liveness

**Capability statement**: A task MUST be withheld from claim on the grounds that
its subject pull request is dead ONLY when the task's anchor identifies that PR
as the task's subject — a binding source with verified confidence. An anchor
derived from a PR number mentioned in prose MUST NOT affect claimability, and
absent anchor data MUST fail open.

> **Scope**: the liveness half of `docs/design/task-subject-anchors.md` (§5-§6) as
> shipped. Intake dedupe, retry-chain lookup and prior-work injection are covered
> by that design doc and by `docs/specs/mcp-action-contracts.md`, not here.

---

### 0. Why this is a contract and not a preference

Two production tasks were unclaimable for **5 days** and **24 days** while the
dashboard rendered them as ordinary `QUEUED` rows. Both carried anchors derived
from a PR number cited as background in their own descriptions
(`{source: 'text', confidence: 'derived'}`); when those unrelated PRs closed, the
reconciliation sweep marked the tasks `reconciled` and the claim gate dropped
them permanently. One was the root of a 20-task dependency funnel, so a single
misclassified anchor stalled an entire workspace.

The gate is correct in intent — a CI-retry task for a genuinely closed PR must
not run. The failure was classification breadth plus invisibility. This spec
fixes the breadth as an invariant, because the natural refactor ("just check
`source`") silently restores the outage, and did in fact ship once on `dev`
before review caught it.

### 1. Binding classification

An anchor is **binding** (may gate claims) when BOTH hold:
- `subjectAnchor.source ∈ SUBJECT_BINDING_SOURCES` (`system`, `context`), and
- `subjectAnchor.confidence !== SUBJECT_ADVISORY_CONFIDENCE` (`derived`).

Otherwise the anchor is **advisory**: it still feeds dedupe and prior-work
context, and MUST NOT influence claimability or task status.

**Invariants**:
- **SA-1**: A task whose anchor is advisory MUST remain claimable regardless of
  `subjectResolution`.
- **SA-2**: Both conditions are required. `source` alone is insufficient because
  `context` is emitted by two extractor paths with different rigour: the
  structured-context mapping resolves the PR and earns `exact`, while an
  explicitly API-supplied `subjectAnchor` defaults to `derived`. Gating on
  `source` alone therefore makes an unverified caller-supplied hint fatal.
- **SA-3**: Absent data MUST fail open. A null anchor, an unselected
  `subject_anchor` column, or a missing `confidence` reads as "no claim about
  liveness", never as dead. A nullable column that defaults to fatal is how the
  original incident became possible.
- **SA-4**: The gate MUST NOT fire without a persisted `subjectPrNumber` and
  `subjectKind = 'pull_request'`.

**Acceptance criteria**:
- AC-1: GIVEN a task with `subjectResolution = 'reconciled'` and anchor
  `{source: 'text', confidence: 'derived'}` WHEN the claim query runs THEN the
  task IS returned as a candidate.
- AC-2: GIVEN a task with `subjectResolution = 'reconciled'` and anchor
  `{source: 'system', confidence: 'exact'}` WHEN the claim query runs THEN the
  task is NOT returned.
- AC-3: GIVEN a task with `subjectResolution = 'reconciled'` and anchor
  `{source: 'context', confidence: 'derived'}` WHEN the claim query runs THEN the
  task IS returned — an unverified API-supplied hint never gates.
- AC-4: GIVEN a query that did not select the `subject_anchor` column WHEN
  `isSubjectDead()` is evaluated on the row THEN it returns `false`.

### 2. One predicate, four consumers

**Invariants**:
- **SA-5**: The SQL prefilter, the in-loop guard, the `/start` override surface
  and the reconciliation sweep MUST all derive their classification from
  `isBindingSubjectAnchor()` / `isSubjectDead()` in
  `apps/web/src/lib/subject-gate-contract.ts`. No consumer may re-express the
  rule inline.
- **SA-6**: The sweep MUST NOT classify more broadly than the claim gate.
  A sweep that terminates a task the gate considers claimable trades a silent
  stall for silent destruction, which is strictly worse than the defect this
  spec exists to prevent.

**Acceptance criteria**:
- AC-5: WHEN the SQL fragment returned by `subjectLivenessCondition()` is
  inspected THEN it references every literal in `SUBJECT_BINDING_SOURCES` and
  `SUBJECT_ADVISORY_CONFIDENCE`, and references none of `text`, `url`,
  `backfill`.
- AC-6: GIVEN any anchor shape WHEN both `subjectStillLive(task)` and the SQL
  predicate are evaluated THEN they agree.

### 3. Terminal subjects terminate

A dead subject on a binding anchor is a permanent condition: nothing
un-reconciles a task.

**Invariants**:
- **SA-7**: When the sweep concludes a binding-anchored subject is dead, the task
  MUST be moved to `cancelled`, not left `pending`.
- **SA-8**: SA-7 is load-bearing beyond honesty. `cancelled` is a satisfying
  status for the dependency gate (`docs/specs/mission-task-lifecycle.md`), so
  terminating the dead task is what releases its dependents. Leaving it `pending`
  starves every downstream task indefinitely.
- **SA-9**: The sweep MUST remain idempotent, MUST restrict writes to tasks in
  `pending` or `assigned`, and MUST NOT alter `completed`, `failed` or
  `cancelled` tasks.
- **SA-10**: Each termination MUST write an audit row to `task_subject_reports`
  naming the dead PR, and the audit MUST reflect only rows the UPDATE actually
  terminated (derived from `RETURNING`, not from the pre-read set).

**Acceptance criteria**:
- AC-7: GIVEN a pending task with a binding anchor whose PR closed with no live
  successor WHEN the sweep runs THEN `tasks.status = 'cancelled'` AND a
  `task_subject_reports` row naming that PR exists.
- AC-8: GIVEN the task from AC-7 has a dependent task WHEN the sweep completes
  THEN the dependent satisfies the dependency gate and becomes claimable.
- AC-9: GIVEN an already-`cancelled` subject-dead task WHEN the sweep runs again
  THEN no UPDATE and no additional audit row is issued.
- AC-10: GIVEN a task with an advisory anchor whose PR closed WHEN the sweep runs
  THEN the task is neither reconciled nor cancelled.

### 4. Legibility and override

This gate is bound by the claim-gate legibility contract
(`docs/specs/mission-task-lifecycle.md`, rules CG-1…CG-6). The gate-specific
obligations:

**Invariants**:
- **SA-11**: `POST /api/tasks/[id]/start` MUST reject a subject-dead task with
  HTTP 422 and `gateReason: 'subject_dead'`. Returning 200 and dispatching
  nothing is prohibited — that response is what made the original incident
  invisible to the operator who tried to fix it.
- **SA-12**: `forceOverride` MUST write `BYPASS_SUBJECT_GATE_KEY` into
  `task.context`, and the claim query MUST honour it in both boolean and string
  form.
- **SA-13**: A subject-dead task MUST NOT render in the `queued` phase on any
  surface that derives status from `deriveTaskPhase()`.

**Acceptance criteria**:
- AC-11: GIVEN a subject-dead task WHEN `/start` is called without
  `forceOverride` THEN the response is HTTP 422 with
  `gateReason: 'subject_dead'`, no Pusher event is broadcast, and the task's
  priority is unchanged.
- AC-12: GIVEN a subject-dead task WHEN `/start` is called with `forceOverride`
  THEN `context.bypassSubjectGate` is persisted AND the claim query returns the
  task on the next poll.
- AC-13: GIVEN a pending subject-dead task WHEN `deriveTaskPhase()` runs THEN it
  returns `subject_dead`, never `queued`.

**Code surface**:
- Contract: `apps/web/src/lib/subject-gate-contract.ts` —
  `SUBJECT_BINDING_SOURCES`, `SUBJECT_ADVISORY_CONFIDENCE`,
  `SUBJECT_DEAD_RESOLUTION`, `BYPASS_SUBJECT_GATE_KEY`,
  `isBindingSubjectAnchor()`, `isSubjectDead()`, `hasSubjectGateBypass()`
- Claim gate: `apps/web/src/app/api/workers/claim/subject-gate.ts` —
  `subjectLivenessCondition()` (SQL), `subjectStillLive()` (in-loop)
- Claim route: `apps/web/src/app/api/workers/claim/route.ts`
- Reconciliation: `apps/web/src/lib/subject-sweep.ts` —
  `sweepSubjectAnchoredTasks()`, `SubjectSweepResult`; callers
  `apps/web/src/app/api/github/webhook/route.ts`,
  `apps/web/src/app/api/workers/[id]/route.ts`,
  `apps/web/src/lib/dead-pr-shutdown.ts`
- Override: `apps/web/src/app/api/tasks/[id]/start/route.ts`
- Extraction: `packages/core/subject-anchor-extractor.ts`
- Display: `apps/web/src/lib/task-presentation.ts` — `deriveTaskPhase()`;
  `apps/web/src/components/StageChip.tsx` — `deriveStage()`
- Data model: `packages/core/db/schema.ts` — `tasks.subjectAnchor`,
  `tasks.subjectKind`, `tasks.subjectPrNumber`, `tasks.subjectResolution`,
  `taskSubjectReports`

**Out of scope**:
- **Stale-but-present anchors.** The `subject_liveness_unknown` refresh path and
  the `subject_review` hold proposed in `docs/design/task-subject-anchors.md` §6
  are NOT implemented. An anchor is treated as live until the sweep says
  otherwise; there is no periodic revalidation.
- **Intake dedupe and retry-chain resolution** — `subject_dedupe_scope`,
  `task_subject_claims`, `fileAnywayReason`.
- **Non-`pull_request` subject kinds** (`error`, `mission`, `branch`). They carry
  anchors but no liveness gate.
- **The extractor's confidence assignment.** SA-2 constrains how the gate reads
  `confidence`, not how extraction assigns it.
