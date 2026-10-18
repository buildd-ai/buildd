---
title: Workflow Kernel Library and Single Host
status: draft
owner: max
last_verified: 2026-10-18
summary: Delivery state MUST have one writer, the workflow kernel, packaged as a library with no buildd imports and run in production only by the execution control plane.
domain: tasks
surfaces: [apps/web/src/lib/override-permission.ts, apps/web/src/lib/workflow/kernel.ts, apps/web/src/lib/workflow/seam.ts, apps/web/src/lib/workflow/command-api.ts, apps/web/src/lib/workflow/kernel-client.ts, apps/web/src/lib/workflow/command-outbox.ts, apps/web/src/lib/workflow/delivery-epochs.ts]
related: [workflow-state-kernel, execution-control-plane, mission-branch-refresh, mission-task-lifecycle, living-specs]
keywords: [scope amendment, mission scope version, workflow kernel, delivery state, single writer, single host, control plane, portable library, ports, adapters, conformance suite, merge door, landing authority, required status, durable findings, finding disposition, delivery epoch, mission delivery, refresh settlement, no-op completion, workflow-kernel package]
verified_by: [apps/web/src/lib/workflow/kernel-telemetry.test.ts, apps/control-plane/src/axiom-export.test.ts, packages/workflow-kernel/src/review-verdict-authority.test.ts, apps/web/src/lib/override-permission.test.ts, apps/web/src/app/api/prs/[prNumber]/approve-override/route.test.ts, apps/web/tests/db/escalation-decisions.test.ts, packages/workflow-kernel/src/decision-refusal.test.ts, packages/workflow-kernel/src/scope-amendments.test.ts, apps/web/tests/db/attempt-writers-slice9.test.ts, apps/web/tests/db/kernel-pr-projection.test.ts, apps/web/tests/db/task-status-writers.test.ts, apps/web/tests/db/reaper-attempt-end.test.ts, apps/web/tests/db/attempt-requeue.test.ts, apps/web/tests/db/claim-attempt-start.test.ts, apps/web/tests/db/attempt-writers-kernel.test.ts, apps/web/tests/db/mission-completion-writer.test.ts, apps/web/tests/db/kernel-merge-heal.test.ts, apps/web/src/lib/workflow/pr-fact-scope.test.ts, apps/web/tests/db/scope-amendments.test.ts, packages/workflow-kernel/src/delivery-epochs.test.ts, apps/web/tests/db/mission-epochs.test.ts, apps/web/tests/db/mission-pr-delivery.test.ts, packages/workflow-kernel/src/landing-gate.test.ts, apps/web/src/lib/workflow/merge-door-inventory.test.ts, apps/web/src/lib/pr-landing-adoption.test.ts, apps/web/tests/db/merge-adoption.test.ts, apps/web/src/lib/release/pinned-merge.test.ts, apps/web/src/lib/workflow/command-api.test.ts, apps/web/src/lib/workflow/kernel-client.test.ts, apps/web/src/lib/workflow/kernel-floor.test.ts, apps/web/src/lib/workflow/command-outbox.test.ts, apps/web/tests/db/kernel-command-host.test.ts, apps/web/src/app/api/cron/pr-reconcile/route.test.ts, packages/workflow-kernel/src/findings.test.ts, packages/workflow-kernel/src/conformance/conformance.test.ts, packages/workflow-kernel/src/merge-hold.test.ts, apps/web/src/lib/required-check-hold.test.ts, packages/workflow-kernel/src/open-pr-status.test.ts, apps/web/src/lib/workflow/open-pr-status.test.ts, apps/web/tests/db/workflow-open-pr-status.test.ts]
supersedes: []
---
# Workflow Kernel Library and Single Host

Owner decision, 2026-10-13. The kernel's state machine is right; what fails is
that state is written from too many places. Kernel tables already have one
writer (`packages/core/__tests__/workflow-write-sites.test.ts`), but the state
people read — task status and result, worker PR columns, mission completion,
"merged" — is written from dozens of routes, crons and subscribers on two
hosts, six merge doors bypass the kernel, and mission refresh decides "shipped"
from a legacy column. Each incident below is one of those writers disagreeing
with the kernel:

| Incident | Writer that disagreed |
|---|---|
| #3787 | a merged mission PR was treated as terminal while the mission kept working (no epoch) |
| #4663 / #4670 | a redundant refresh PR stayed open after the mission shipped, then retargeted to trunk when its base was deleted |
| #4679 | requested changes stayed presented after the fix landed; resolution is not a recorded fact |
| #4686 | the mission PR never had a delivery; a coordination-only repair made no edits and was accepted; a person merged on GitHub over open findings |
| mission ecea17f3 | repeated "merge dev into mission branch" tasks, including some filed after the mission shipped; a verified no-op refresh could not complete |

This spec owns four things: the ownership rule (§1), the package boundary (§2),
the single host (§3) and the landing authority across every door (§4). It also
states the aggregates the incidents need (§5 findings, §6 mission deliveries
and epochs) and the order of work (§8).

It does not restate the state machine. States, transitions T1–T29, CAS,
exact-head review, the push invariant, the outbox and the floor stay in
`workflow-state-kernel.md` §4–§11, and the review-composition, findings,
repair and completion-evidence rules stay in its §13.13 rules 1–5 and 9. This
spec amends where those run and who else may write, and §5 adds three things
to rule 2 (a stable finding id, `addressed`, `deferred`), which §13.13 rule 2
carries since slice S5.

| Spec | Relationship |
|---|---|
| `workflow-state-kernel.md` | behavioural contract the library implements. §10.3 drain hosting, §11 floor hosting, §13.12 "server-side (`apps/web`)", AC-7 and §14 are amended by §1 and §3 here. §13.13 rule 2 is amended by §5 (stable id, `addressed`, `deferred`). §13.13 rule 6, rule 7, rule 10 and its D1–D13 inventory are the landing authority of §4. |
| `execution-control-plane.md` | §1 "same handlers, second host" and the seven-route limit are amended by §3; §3's kernel path becomes the package path. |
| `mission-branch-refresh.md` | keeps the `branchRefresh*` columns; the refresh becomes a kernel effect of a mission delivery (§6). Its "does not model epochs" note is answered by §6. |
| `mission-task-lifecycle.md` | AC-64's door list (was AC-11y) is replaced by §4; mission completion reads delivery state (§6). |
| `pr-lifecycle-reconciliation.md` | I-3's per-render write-through is retired by §1 (renders never write). |
| `living-specs.md` §10 | the pattern this package follows. |

## 1. One writer

**Capability statement**: Delivery state MUST be written only by the kernel,
through its commands, so every surface reads the same answer to "where is this
work" and no code path can advance or contradict it on its own.

**Invariants**:
- Delivery state is: the kernel tables (`workflow_deliveries`,
  `workflow_review_rounds`, `workflow_facts`, `workflow_transitions`,
  `workflow_effects`, `landing_lanes`, `workflow_attempts`,
  `workflow_mission_epochs`, `trunk_incidents`); and, for any task that has a delivery, the lifecycle
  columns people read: `tasks.status` and `tasks.result` delivery fields
  (`prUrl`, `prNumber`, merged/shipped), `workers.prUrl`, `workers.prNumber`,
  `workers.mergedAt`, `workers.prLifecycleStatus`, and mission completion.
- Those task, worker and mission columns become projections the kernel writes
  in the same statement as the transition that changes them, or are derived on
  read. No other module writes them for a delivery-owned task. A task with no
  delivery (a research task, a bookkeeping task) keeps its current writers.
- Facts enter only as facts: a webhook, a GitHub read, a worker PATCH, a
  person's action are recorded (`observePrState`, `recordPrFact`, attempt
  ended) and the reducer decides. Ingesting a fact never writes a status.
- Page renders, MCP reads and `explain` never write delivery state, including
  in `after()`.
- Every write site outside the package for the columns above is listed in §9
  and burns down to zero by slice S4. A guard test (the S4a block of
  `packages/core/__tests__/workflow-write-sites.test.ts`) fails on a new one,
  naming the file, and lists each remaining site with its reason.

**Acceptance criteria**:
- AC-1: GIVEN a delivery-owned task WHEN any module outside the kernel package
  issues an UPDATE to `tasks.status`, `workers.mergedAt` or
  `workers.prLifecycleStatus` for it THEN the write-site guard fails CI naming
  the file.
- AC-2: GIVEN a `pull_request.closed` merged webhook for a kernel-owned PR
  WHEN it is processed THEN the task, worker and delivery reach their merged
  states from one kernel transition, and `runMergedPrWork` performs only
  side effects (events, notifications), never a status write.
- AC-3: GIVEN a page render of a task whose GitHub state changed WHEN it
  renders THEN it shows the delivery's projection and records at most a fact;
  no status column changes during the request.
- AC-4 (failure): GIVEN a fact that contradicts the delivery's state (a merged
  webhook for a delivery already ABANDONED) WHEN ingested THEN the reducer
  records it with its contradiction reason and no column changes outside the
  transition the reducer returns.

## 2. The library

**Capability statement**: The kernel MUST be a package that imports nothing of
buildd's and runs its whole contract against in-memory adapters, so it can be
embedded by another product and its behaviour is proven without a database,
GitHub or Next.js.

**Invariants**:
- Package: `@buildd/workflow-kernel` at `packages/workflow-kernel`, same shape as `@buildd/spec-contract`: source
  consumed directly, strict tsconfig, no `dependencies` or
  `peerDependencies`, WebCrypto not `node:crypto`, a boundary test that scans
  every tracked file for `@buildd/*`, `drizzle-orm`, `@neondatabase/*`, the
  `@/` alias, `next/*` and `../`, proves its pattern can fail, and is listed in
  `scripts/always-run-tests.txt`.
- Contents: the reducer, commands, types, base-delta, hand-off, projections,
  delivery display, landing-lane rules, trunk signature, review composition,
  the findings model (§5) and the epoch model (§6). The visual-review cluster
  is not kernel code and stays in apps/web.
- Ports, each a TypeScript interface the host implements
  (`packages/workflow-kernel/src/ports.ts`, `PORTS_VERSION`; composed as
  `KernelPorts`):
  - Store: the kernel's statements (transition CAS, fact insert, effect
    claim/ack/fail/park/renew, lane acquire/release, view load). The contract
    is one statement per transition; a uniqueness conflict means "lost the
    race, re-read". `Store` is implemented by `MemoryStore`
    (`src/memory/store.ts`) with the Postgres unique indexes, CAS guard,
    outbox lease/fence and lane rules, and by buildd's `postgresStore`
    (`apps/web/src/lib/workflow/postgres-store.ts`), which runs today's
    statements (`transitionSql`, `claimDueEffectsSql`, `acquireLaneSql` and
    their families, unchanged) and keeps drizzle in the host. The logic that
    sequences them is the package's: `applyCommandOn`
    (`src/command-runner.ts`), `drainEffects` (`src/effects.ts`),
    `acquireLaneOn` / `settleLanesOn` (`src/landing-lane.ts`); apps/web's
    `applyCommand`, `runEffects`, `acquireLane` and `settleLanes` delegate
    to them with the Postgres store. NOT IMPLEMENTED: the ingest funnel
    (`ingestFact`), authority resolution and the projections' SQL still
    sequence their statements in apps/web.
    The Store also binds a ledger row to the task filed for it
    (`linkAttemptTask`, `linkAttemptTaskSql`).
  - GitHub facts: `GithubFactReader` (now the package's; `facts.ts`
    re-exports it), plus `GithubWrites`, the writes the effects need (merge
    at a pinned head, post a review, publish a commit status, update a
    comment, delete a branch). `mergeAtHead` answers in T16 terms
    (`MergeAnswer`: the `MergeCallResult` outcome, GitHub's message, when to
    call again); the host reads GitHub's answer into it. A host with an
    installation per workspace supplies `githubFor(workspaceId)` instead of
    one `github` (`githubOf` picks). buildd's adapters are in
    `apps/web/src/lib/workflow/kernel-ports.ts`: `builddGithubWrites` over
    `@/lib/github`, `builddGithubFor` (the workspace's installation, its
    live reads and writes); how a merge answer reads as T16 is the reviews
    module's `mergeAnswerOf` (`pr-landing-effects.ts`). `postReview` says
    whether the review went up (a matching review already there, a verdict
    on the host's own PR posted as a comment). The host halves that do git
    work (the composition attestation, a base refresh, a migration renumber)
    still call `@/lib/github` themselves, behind their ports.
  - Clock: `now()`; the in-memory store and the conformance suite use a
    controllable clock (`controllableClock`, `src/memory/clock.ts`). SQL
    `now()` stays inside the Postgres statements.
  - Work: file a task of a given role under the kernel's own id (the ledger
    row's, or the trunk anchor's), with a pinned target, lineage and the
    detail the host's builder needs; the host may answer `skipped` (nothing it
    can file now) or `evidence` (still owed for the new task, which the kernel
    turns into a follow-up effect). Also wake a task, cancel one, cancel a
    delivery's pending tasks of a role, and steer a filed task. buildd's
    adapter is `builddWork` (`kernel-ports.ts`: the task insert under the id,
    `announceTaskCreated`, `wakeTask`, the instruction queue), with each
    role's row shaped by its module's builder handed in from the root
    (`ciFixWork`, `trunkFixWork`); `RecordingWork` in memory.
  - Notify: a delivery's activity comment and team notifications. Port and
    `RecordingNotify` exist; `activity` answers with the render's outcome.
    buildd's adapter is composed at the root: the comment render
    (`activityNotify`, `pr-activity-effects.ts`, loaded on its first render)
    and `notifyTeamOf`, which refuses an alert kind it does not know
    (`isTeamAlertEvent`) instead of casting it.
  - Trunk: the trunk breaker's incident ledger (read an incident, its fix
    anchor, link its fix, the host's failing-check signature). buildd's is
    `builddTrunk` (`trunk.ts`) over `trunk_incidents`; `RecordingTrunk` in
    memory. Comparing signatures is the package's (`src/trunk-signature.ts`).
  - Escalate: hand a delivery whose repair family ran out to a person
    (`ciEscalate` for family `ci`); Evidence: capture run evidence the host
    keeps (`ciEvidence`, the CI job log). `RecordingEscalate`,
    `RecordingEvidence` in memory.
  - Ingest: the fact funnel an effect hands a live read's fact to
    (`IngestFact`: a close or a head move). Still buildd's `ingestFact`
    (`builddIngest`); `RecordingIngest` in memory.
  - Lifecycle: what the host does at a delivery's lifecycle points, which the
    kernel orders but cannot know: project a supersession or abandonment onto
    its records, scan for where a closed PR's work landed, wake whatever
    coordinates the owner, the once-per-merge work, and tidying after a merge.
    buildd's halves are `supersessionLifecycle` (`supersession-effects.ts`)
    and `landingLifecycle` (`pr-landing-effects.ts`); `RecordingLifecycle` in
    memory.
  - Decide: optional model-backed judgment at named decision points, below.
    buildd's adapter is `builddDecide` (`decision-port.ts`, the decisions
    module, handed in from the root), over its decision-model layer.
  - Reviews, Conflicts, HandOff: the review loop's and conflict families'
    host halves (a reviewer's output, the §5.9 composition attestation, a
    review GitHub refused, the approval's supersession, the escalation
    notice; the git work of a base refresh and a migration renumber, and the
    migration inspector's "still owed"), and legacy's first review for a
    delivery the kill switch released before its first round. buildd's are
    `reviewsHost` (`review-effects.ts`), `conflictsHost`
    (`conflict-retry-effects.ts`) and `handOffHost` (`review-handoff.ts`);
    `RecordingReviews`, `RecordingConflicts`, `RecordingHandOff` in memory.
  - Policy: the per-workspace knobs the kernel reads (kill switch, landing
    lane mode, max rounds, max conflict iterations), passed in, never queried
    from a host table inside a kernel statement. buildd's adapter is
    `builddPolicy` (`apps/web/src/lib/workflow/kernel-policy.ts`, one read of
    `workspaces.git_config` through `kernelEnabled`,
    `resolveLandingLaneMode` and the policy overrides); `staticPolicy` in
    memory. The drain reads the kill switch from it (`DrainOptions.policy`,
    once per workspace per drain): the effect claim and lease renewal report
    only the delivery row's own authority and its workspace. The conflict
    family reads its lane mode and agent budget from it, and the legacy
    hand-off whether the switch is still off. NOT IMPLEMENTED: the
    transition CAS and the authority resolution statements (`authority.ts`
    `resolveSql`) still read the switch in SQL (`kernelOnSql`).
- Effect handlers in the package are written against these ports only
  (`packages/workflow-kernel/src/handlers/`; `kernelEffectHandlers(ports)`,
  the kinds in `KERNEL_HANDLED_EFFECTS`). A handler whose port the host did
  not supply throws, so its effect backs off and goes dead rather than being
  acked. The host composes them with its adapters once, on first use:
  buildd's `workflowKernel()` (`kernel-ports.ts`) builds the ports from the
  composition root's one slot (`workflowKernelHooks` in `@/modules`) and
  runs the package's handlers for every effect kind; buildd adds only its
  own projection, `stamp_pr_rows` (`pr-fact-effects.ts`). Implemented: landing
  and post-merge work (`merge_call`, `verify_merge`, `emit_pr_merged`,
  `finalize_mission_pr`), a closed PR's resolution (`scan_supersession`,
  `project_supersession`, `wake_mission`), the PR activity render
  (`render_activity`), the CI family (`dispatch_ci_fix`, its follow-up
  `capture_ci_evidence`, which replaced work in `after()` and records an
  `evidence_captured` fact, and CI exhaustion), the trunk breaker
  (`dispatch_trunk_fix`, `cancel_open_attempts` for `blocked_on_trunk`), the
  review loop (`dispatch_review`, `dispatch_fix`, `post_review`,
  `mission_note`, `notify`, `push_recovery`, the review cancellations, review
  exhaustion), the conflict and migration families (`refresh_branch`,
  `renumber_migration`, `dispatch_conflict_fix`, conflict exhaustion) and the
  §14 legacy hand-off (`handOffToLegacyOn`, which `seam.ts`
  `handOffToLegacy` calls). A kind several families share
  (`escalate_exhaustion`, `cancel_open_attempts`) is answered per family; a
  family the kernel does not know is `skipped:legacy_owns`. A close's or a
  merge's `cancel_open_attempts` (reasons `closed`, `merged`) is the kernel's:
  it cancels the unstarted tasks the transition named (b6cfdbb9); the legacy
  reconciler skips a kernel-owned PR, so nothing else would.
- Conformance suite: `CONFORMANCE_SCENARIOS`
  (`packages/workflow-kernel/src/conformance/scenarios.ts`), host-independent
  scenarios over a `ConformanceHost`, run on the in-memory store by
  `src/conformance/conformance.test.ts` and on the Postgres store by
  `apps/web/tests/db/workflow-kernel-conformance.test.ts` (`bun run
  test:db`) with identical expectations, so a host adapter is proven by the
  suite, not by hand. It covers the §16 S2, S5, S6 and S20 rows, the CAS and
  open races, the #4679 and #4686 sequences, the outbox drain (ack, backoff,
  §10.4 supersession, §14 kill switch), the landing lane, AC-27–AC-29, and
  the package's handlers (the `handlers/...` scenarios) run by a real drain
  on a fake GitHub (`FakeGithub`) and the recording Ingest, Lifecycle and
  Notify, Work, Trunk, Escalate, Evidence, Reviews, Conflicts and HandOff,
  for every handler family (a `handlers/...` scenario may also run a handler
  directly, past the drain's guards, so the handler's own guard is what it
  tests). The host's `policy` is part of the `ConformanceHost`: the drain
  reads the kill switch from it on both stores. Every kernel-decided §16
  matrix row is a scenario too (`matrix-scenarios.ts`, see
  workflow-state-kernel.md §16). The incident sequences are scenarios of
  their own (`incident-scenarios.ts`): the #3787 double ingest of a merged
  epoch (one successor), the #4663/#4670 refresh with unique work left on a
  merged branch (held, never retargeted to trunk), the §15 replay of #3754
  (`head_already_reviewed`), and the #4686 chain end to end (a mission
  delivery opens, changes are requested, a coordination repair ends with no
  edits, a person merges on GitHub). The epoch scenarios reach the host's
  epoch rows through `ConformanceHost.epochs` (`EpochHost`: seed a mission,
  load its epochs, apply one transition's ops all or nothing), so the
  in-memory store and buildd's `applyEpochOpsSql` meet the same CAS and
  unique-index expectations. `conformance.test.ts` plants one adapter fault
  per incident and checks its scenario fails at the step it guards.
- No model calls, prompts or decision policies in the package. Model-backed
  judgment stays possible through the Decide port:
  - Where the kernel needs a judgment (a reviewer verdict, whether a conflict
    resolution is safe to take, which recovery to try, an escalation
    recommendation), it either reads a fact the host supplied (a verdict from a
    review round) or asks the host's decider at a named decision point:
    `Decide.decide(point, input)` returning a verdict, a confidence and a
    reason, or no answer (`src/ports.ts`), reached only through `decideAt` /
    `decideAndRecord` (`src/decide.ts`), with a bounded timeout
    (`DECIDE_TIMEOUT_MS`). The first point is `VISUAL_IMPACT_POINT` (default
    `review_required`). buildd's visual-impact classifier asks it through
    `decideAndRecord` on the mission integration PR's delivery
    (`visual-review-impact-load.ts`, with a 15 s bound above the decision
    model's own 5 s), so a head's answer is recorded once and replayed after
    that, a default taken for a head included; with no delivery it asks
    through `decideAt` and records nothing.
  - Every decision point has a deterministic default in the package. No
    decider, no answer, a timeout or an error takes the default, and the
    fallback reason is recorded. A recorded fact that cannot be read as a
    decision takes the default too (`invalid_record`), recorded beside it
    under `invalidRecordFactKey`, so a replay answers the same and never
    throws. A decider can never be required for the
    kernel to make progress, and its answer never bypasses a gate (§4).
  - The answer is recorded as a fact on the delivery (point, decider id,
    verdict, confidence, reason) before the transition that uses it. Replay
    and the conformance suite read the recorded fact and never call a
    decider, so a delivery's history is deterministic. The fact is a
    `workflow_facts` row of kind `decision` keyed by `decisionFactKey`; the
    transition that uses it passes it as `factId`, which links it.
    `src/decide.test.ts` fails if the reducer, commands or projections import
    `decide` or read a decision fact.
  - In buildd the decider is the decision-model layer (its ledger and
    thresholds stay in the product); another host plugs its own or none.
- The package's ports and records are versioned; a breaking change bumps the
  major and the conformance suite of the old major keeps running until no host
  uses it.

**Acceptance criteria**:
- AC-5: GIVEN the package WHEN its boundary test runs THEN no tracked file
  imports a buildd package, a database driver, `next/*` or a path outside the
  package, and the test fails when such an import is planted.
- AC-6: GIVEN only the package and its in-memory adapters WHEN the conformance
  suite runs THEN every §16 matrix row and every incident sequence passes,
  with no database and no network.
- AC-7: GIVEN the Postgres adapter WHEN the same suite runs under
  `bun run test:db` THEN it passes with identical expectations.
- AC-8 (failure): GIVEN an effect handler that calls a host module directly
  instead of a port WHEN the boundary test runs THEN it fails naming the
  import.
- AC-27: GIVEN a decision point and a host decider that answers WHEN the
  kernel reaches it THEN the answer is recorded as a fact with the decider id
  before the transition that uses it.
- AC-28: GIVEN a recorded decision fact WHEN the delivery is replayed THEN the
  replay uses the recorded answer and calls no decider.
- AC-29 (failure): GIVEN no decider, or a decider that errors or times out,
  WHEN the kernel reaches a decision point THEN it takes the package default,
  records the fallback reason, and the delivery still progresses.

## 3. One host

**Capability statement**: In production the kernel's commands, effect drain
and floor MUST run only on the execution control plane, so a transition is
never applied by two hosts with different code or by a host that is down.

Owner decision, 2026-10-13: the control plane hosts the kernel; it is not a
separate service. The command API is the service boundary: versioned,
idempotent and authenticated. Q2 below is answered by that decision (a route on
the control plane, authenticated as the caller).

**Invariants**:
- The control plane (`apps/control-plane`) is the only process that calls a
  kernel command or drains `workflow_effects` in production. This amends
  `execution-control-plane.md` §1: the Worker hosts the kernel, not only the
  seven handler routes.
- The command API is `POST /v1/commands` on the control plane's own hostname,
  never on a `buildd.dev` route (`apps/web/src/lib/workflow/command-api.ts`,
  routed by `apps/control-plane/src/router.ts`):
  - Versioned. The body carries `v: 1`; any other version is a 400 naming the
    one this endpoint speaks. A breaking change is a new path (`/v2/...`) served
    beside the old one until no door sends it.
  - Operations are the seam's door functions, unchanged: `land`,
    `apply_recommendation`, `policy_merge`, `request_review`,
    `request_ci_retry`, `record_supersession`, `abandon`, `open_delivery`, and
    `drain` (one delivery's due effects, `system` principals only), `heal`
    (one delivery's fast heal, the floor pass narrowed to it, `system`
    principals only), and
    `mission_epoch` (§6: a mission delivery merged, ensure a writable one, bind
    its PR, reconcile what is owed; re-checked against the mission's repo
    workspace), and `attempt_ended` (T4: an attempt's end as the worker
    PATCH, the reaper, a cancel or a reviewer takeover reports it; the
    task's workspace rides on the input for the reach check, and the host
    refuses an end whose task is in another workspace; during a release, a
    control plane that predates the op refuses it as an unknown op and
    applies nothing, and only then the web host applies the end itself and
    logs it loudly, so a repair's or review's end is never lost; any other
    refusal stays a refusal), and `observe_ci_failure` (T10 from buildd's
    own CI doors: the red-PR sweep `cron:ci-red`, the landing path and the
    `check_suite` subscriber, each as a `system` principal; the same skew
    rule applies, so a red PR is never left without its repair), and
    `observe_ci_green` (`CiGreenObserved`, and the `CiObserved` reading
    outside a repair, from the `check_suite` success webhook as a `system`
    principal; the same skew rule applies, so a repair is never left waiting
    on a green GitHub sends once), and
    `record_review_verdict` / `adopt_review_verdict` (T6 from the worker
    PATCH: a kernel round's verdict, or one from outside the rounds on a PR
    the kernel owns) and `claim_fix` (T9 from the claim route, one request in
    place of the seam's own reads), and `observe_conflict` (T12 from the
    conflict door: landing, the merge routes, auto-merge, the dead-zone sweep
    and the migration-collision dispatch, as a `system` principal; the live PR
    is read on the control plane), and `observe_pr_state` (T17 to T19: a PR
    closed, merged or reopened, from the GitHub webhook, the reconcile and
    refresh sweeps and the dependency gate), `observe_head` (T3, the
    `synchronize` webhook) and `observe_base` (T29, a retarget's `edited`
    webhook), each as a `system` principal, each for the caller that reported it,
    with the same skew rule; each names its workspace on the input, and the
    host acts only on a delivery of that workspace (a verdict for another
    workspace's delivery is refused, never read as a release to legacy). A
    claim request's fix claims share one control-plane budget; once it is
    spent the next fix candidate defers at once as `kernel_unavailable` and
    the rest of the batch is claimed; a fix claim the control plane refuses
    (403: auth, the claiming account's reach) defers as `kernel_refused`,
    not as an outage. The same
    code runs on the web host in shadow, so the two modes cannot drift.
  - Authenticated. The request is signed: HMAC-SHA256 over timestamp, method,
    path and body (the scheme Dispatch callbacks use, `@buildd/dispatch-contract`)
    with the dedicated command key ring `KERNEL_COMMAND_SECRET`
    (`keyId:secret[,keyId:secret]`, two ids live during rotation). The secret is
    required: nothing is derived from another secret, and while it is unset the
    control plane refuses every request (503 `unconfigured`). A bad or missing
    signature is a 401, before anything runs. The body names the
    principal the calling host vouches for (`user`, `account`, `grant` or
    `system`), and the endpoint re-checks that it still reaches the workspace
    with the same workspace reach rule as the web host, including grants
    (team membership for a person, the grant's workspaces and its write
    scope for an account-level grant session, since every command is a
    write, workspace reach for any other API account);
    a principal that does not is a 403. An `account` principal says it is not
    a grant (`grant: null`); one that does not, from an older host, is refused
    when it names a team's shared session account. The door keeps its own
    authorisation; the endpoint proves who it acts for.
  - Idempotent on a caller-supplied key. The key is claimed in Postgres
    (`workflow_commands`, `command-ledger.ts`) before the operation runs,
    never in Worker memory. A second request with the key waits for the first
    and receives its stored answer with `replayed: true`; one still running
    past the wait answers 409 `in_progress` (retryable, same key). The same key
    with a different request is a 422. An operation that throws stores
    nothing, so the key may be retried. A running command renews its claim
    every ten seconds (`COMMAND_HEARTBEAT_MS`); a claim not renewed for the
    lease (thirty seconds, `COMMAND_LEASE_MS`) belongs to a request that died
    mid-command and is taken over by the next request with its key; completion
    is recorded only for the claim that still holds the key. The Worker hands
    every command it starts to `waitUntil`, so a caller that times out and
    disconnects does not cancel it mid-way. A ledger that does not answer
    before the claim is a 503 `ledger_unavailable`, and a reach check that
    could not be made is a 503 `reach_unavailable` (nothing ran, `applied:
    false`; only an answered "no" is a 403), never an uncaught throw, which the Workers runtime turns into a
    bare 500 the caller must read as "may have run"; the client retries it
    once and then answers `not_applied`. Keys are kept seven days.
  - Answered with the operation's result and the delivery's version:
    `{ v, op, idempotencyKey, result, delivery: { id, version } | null, host, replayed }`.
  - Only the host applies. A process that is not the control plane in `own`
    mode answers 409 `not_host` and applies nothing.
- Doors reach the kernel through one client module,
  `apps/web/src/lib/workflow/kernel-client.ts` (`submitKernelCommand`). On the
  control plane it runs the operation in-process. On the web host in shadow it
  runs the same package locally, exactly as before. On the web host in own
  mode it submits the command, signed, retrying with the same key, and returns
  the control plane's answer. If the control plane does not answer within the
  door's budget the client raises `ControlPlaneUnavailableError` and the door
  answers 503 with a retryable error naming the control plane
  (`controlPlaneUnavailableResponse`); nothing is applied on the web host. The
  error says what is known: `not_applied` only when the connection itself
  failed (refused, or the name did not resolve: `ECONNREFUSED`, `ENOTFOUND`,
  `EAI_AGAIN`), `unknown` for anything else (a timeout, a reset after the body
  was sent, `in_progress`, a 5xx). Both carry the idempotency key, and so does
  the door's 503: retrying with that key returns the control plane's answer and
  never applies the command twice. Once any attempt of a door call may have
  reached the control plane, the web host never runs that command itself: a
  later `not_host`, `unconfigured` or shadow reading raises `unknown` instead.
- A door command nothing else re-sends is not lost when the control plane
  does not answer (`apps/web/src/lib/workflow/command-outbox.ts`). An
  attempt's end (`attempt_ended`: the runner reports it once, and the floor
  re-sends only an owner's), a reviewer's verdict (`record_review_verdict`,
  `adopt_review_verdict`: reported once, in the completion PATCH) and
  GitHub's one green (`observe_ci_green`) are parked in `workflow_command_outbox` under the door's own idempotency key,
  with their input, principal and whether an earlier submission may have
  reached the control plane; the door still answers unavailable, with
  `parked: true`. Every op is classified in `PARK_ON_UNAVAILABLE`, so a new op
  does not type-check until someone decides. A door whose caller retries (a
  person's merge, a sweep's observation) is not parked; a fix claim
  (`claim_fix`) never is, since the claim it revalidates is rolled back and
  claimed afresh. An answer is never parked either: a refusal, the command's
  own failure, or the release-skew fallback.
  - The kernel floor drains it. On the control plane it applies each due row
    itself through the same reach check, installation and ledger as a
    request (`applyCommandRequest`); on the web host (shadow, or the liveness
    fallback) it re-submits through the client with the same key. The ledger
    is read first: a key done there is settled as replayed and never sent; no
    ledger row means nothing ran under it; a live claim is waited for. So a
    parked command is applied at most once whoever drains it.
  - Order: the command is re-submitted as it was and judged as the delivery
    stands when it lands, so one a newer head, round or attempt has overtaken
    is answered stale (or for another head) and settled, never applied.
  - A row settles on any answer (applied, duplicate, stale, rejected); a
    refusal, or 48 attempts, gives it up as `dead`, logged and counted as a
    floor error. A control plane still down stops the pass at the first row.
- Doors that run on Vercel today (dashboard and chat merge, MCP `merge_pr`,
  `create_pr`, re-review, retry-CI, apply-recommendation, supersession,
  `update_task` on a delivery-owned task, `correct_task_result`) submit a
  command through that client and return its result. Every caller of a door
  command goes through it, the landing sweep, auto-merge, the policy-merge
  rule, operator recovery and the PR subscribers included; a module outside
  the kernel that reaches one on the seam (a named or namespace import, a
  dynamic `import()`, by alias or any relative path) fails
  `packages/core/__tests__/workflow-write-sites.test.ts`, except the files it
  lists with a reason (the web-down e2e harness, which seeds a delivery
  itself). A door names its authenticated caller (`kernelPrincipalOf`): a grant
  session as its grant, else a person by id, else the API account; only
  buildd's own sweeps and rules name a system principal, and a command with
  no principal is never sent to the control plane. A door's
  `Idempotency-Key` header, when sent, is the command's key, and one key
  covers the whole door call: on an `unknown` outcome the door submits again
  with that same key (twice more at most, `DOOR_UNKNOWN_RETRIES`) inside one
  door budget of 20 seconds (`DOOR_BUDGET_MS`, well inside the routes' function limit;
  a merge door holds its surface's merge slot for the
  whole call). It never retries a refusal (4xx), the command's own failure on
  the control plane (`command_failed`, reported as the real error) or a local
  throw. Every door answers a door error in one shape (`doorErrorAnswer`): 503
  `control_plane_unavailable` (retryable, with the outcome and the key), 403
  `control_plane_refused`, or 500 `command_failed` with the key; supersession
  and abandonment pass the same body through. `update_task` and `correct_task_result` issue no kernel
  command today: their writes to a delivery-owned task's columns are the
  one-writer work of §1 (S4), not a command to move.
  GitHub's own PR facts are door ops too, so no kernel command is applied on
  the web host in own mode (AC-9). `observe_pr_state` keeps its contract
  across the boundary: when the kernel's live read of GitHub fails, the host
  records the caller's own observation (the webhook's pull object, cut to the
  fields the kernel reads) as an unapplied fact, schedules the fast heal, and
  answers `observationFailed`, which the door throws as
  `KernelObservationFailed`, so the caller neither takes a legacy path nor
  reports success. A control plane that does not answer, refuses the
  command or fails it is the same failed read: the web host reads ownership
  itself and, for a kernel PR, records the observation unapplied (a fact, as
  a render does, AC-3) and schedules the heal; only a PR the kernel does not
  own goes to legacy. It is never parked: the unapplied fact and the sweeps
  are its re-senders. The heal queue is read by the web host's per-minute
  tick, but in own mode that tick only asks the control plane to heal each
  due delivery (`heal`); the floor pass, and any T17 to T19 it applies, runs
  there. An unconfirmed heal is re-marked while the delivery is still owed,
  and the floor backs it. GitHub sends `synchronize` and a retarget once, so
  an unanswered `observe_head` or `observe_base` is parked (AC-74), and the
  webhook route gives every door a short shared budget so its response beats
  GitHub's timeout (AC-65); unanswered,
  refused or failed, ownership is read on the web host so legacy never acts
  beside the kernel. `recordLocalHead` is one provenance
  statement on an attempt row, not a command. `cancelSkippedTask` writes a
  task row the claim route owns.
- Routing is off until `KERNEL_COMMAND_SECRET` is set on the web host: without
  it the web host runs the package itself, exactly as before, whatever either
  host's `EXECUTION_MODE`, and the control plane's cron does nothing. With it,
  the mode is one setting: the control plane's `EXECUTION_MODE`. The web host
  follows the Worker's health `kernel` field, which is `own` only when the
  Worker is in own mode and holds the command key (`mode` alone still says who
  answers the execution routes) (`/__control-plane/health`, read
  with a short timeout and cached for 30 s; concurrent callers share one read,
  and a failed read is not repeated for 5 s, `MODE_RETRY_MS`; a reading up to five minutes old
  stands in for a failed re-read; no reading at all counts as `own`, so a door
  fails retryably rather than applying a command the control plane may also be
  applying). A 503 `unconfigured` from the control plane is answered like
  `not_host`: it ran nothing, so the web host runs the command itself. `EXECUTION_MODE` set on the web host overrides that for tests and
  a local e2e; off Vercel with nothing set the web host is the host, since no
  control plane is there to follow.
- The drain and the floor (`drainDueEffects`, `reconcileKernelDeliveries`,
  trunk incident reconcile, treadmill restart, and pruning the command ledger)
  are one pass, `runKernelFloor` (`apps/web/src/lib/workflow/kernel-floor.ts`).
  In own mode it runs on the control plane's cron trigger
  (`apps/control-plane/wrangler.jsonc`, `triggers.crons`, hourly at :10, the
  web app's merge-state minute, so it opens no extra Neon wake window) and is
  recorded as the `kernel-floor` cron run, which names the host that ran it;
  `/api/cron/pr-reconcile` skips it (`kernelSkipped`). In shadow, or before the
  switch-over, `/api/cron/pr-reconcile` runs it and the control plane's tick
  does nothing and reads nothing. Liveness fallback: even switched over,
  `/api/cron/pr-reconcile` runs the pass itself whenever the control plane's
  newest successful `kernel-floor` run is older than one and a half cron
  periods (`KERNEL_FLOOR_STALE_MS`, 90 minutes) or has never happened. Both
  crons fire at :10, so a healthy floor is about one period old when the web
  host looks, and one missed control-plane tick is caught at the web host's
  next tick. It records `kernelHost: web` with
  `kernelReason: control_plane_floor_stale`. A cron trigger that was never
  deployed, or a stopped Worker, can delay the drain, never stop it. An effect is never
  drained inline at the end of a Vercel request in own mode: the seam's inline
  drain becomes a `drain` command to the control plane, best effort, with the
  floor as the backstop.
- A sweep's time on the control plane is bounded. `/api/cron/pr-reconcile`
  runs each pass (merge-state, landing, red-PR) inside one control-plane
  budget, `withControlPlaneBudget` (kernel-client.ts), of 30 s for all of its
  sweeps together (`SWEEP_CONTROL_PLANE_BUDGET_MS`, well inside the route's
  60 s). Every door call and inline drain in it is cut to what is left; an
  inline drain waits at most 2.5 s for its answer (`PASS_DRAIN_WAIT_MS`), since
  the control plane finishes it either way. Once the budget is spent nothing
  more is sent: a door gets `ControlPlaneUnavailableError` with outcome
  `not_applied` at once, and a drain is left to the control plane. A sweep
  defers only an outage (`ControlPlaneUnavailableError`, retryable), never as a
  judgement on the PR: the closed-PR supersession scan stamps nothing and
  suggests nothing (outcome `deferred`), the superseded-refresh retirement
  records no stranded event and tries no second successor, and the escalation
  dispatcher gives its claim back and counts it, so the next tick retries each.
  A refusal (`KernelCommandRefusedError`) or the command's own failure
  (`KernelCommandFailedError`) is deterministic and is settled as before
  (suggested and stamped, kept as stranded, settled skipped). A deferral is
  bounded (`control-plane-deferral.ts`: 24 deferrals or 24 hours from the
  first): past it the scan is stamped with a suggestion saying why, the
  retirement stops retrying, and each records a `stranded` gate event
  (`control_plane_deferral_exhausted`); the escalation dispatcher settles an
  outage `skipped` with its cause in the last hour of its 6 h window. Landing,
  held releases and the pinned release merge already leave the work pending. Each step of a pass logs its time as it finishes, and the pass result
  carries `timings` per step and `controlPlane` (calls sent, refused unsent,
  drains skipped, time waited), so a slow run names the step it waited on.
- Every transition row records the host that applied it
  (`workflow_transitions.host`: `control-plane` or `web`, null on rows written
  before the tag). The Worker's entry sets it in code (`kernel-host.ts`), never
  from an env var.
- Effects run under the Worker's request budget. An effect that needs longer
  is split into a fact-producing step the drain can retry, or handed to
  Dispatch: CI evidence capture is its own effect (`capture_ci_evidence`)
  recording an `evidence_captured` fact, not work in `after()`.
- Reads (task page, mission page, `get_pr`, `explain`, Home) read projections
  from Postgres directly on either host; reading needs no command.
- `EXECUTION_MODE=shadow` still passes every request to Vercel, and in shadow
  the Vercel host runs the same package. The rollback stays one setting;
  the single-host rule holds per mode, never both at once.
- Lockstep (`execution-control-plane.md` §2) is not a precondition for command
  submission: a Vercel door that sees `lockstep: false` in deploy identity
  still submits, because the control plane is the authority, and the release
  watcher degrades the release as today.

**Switching over** (owner/operator steps, DONE; see the record after the
steps). Merging and releasing this code changed nothing on its own: without the
secret the web host keeps applying commands and draining exactly as before. The
order matters: the control plane first, then the web host.

1. Set `KERNEL_COMMAND_SECRET` on the control plane Worker (a Worker secret),
   and run `wrangler triggers deploy` for it from an account login so its cron
   trigger exists (the release workflow deploys versions, not triggers).
   Confirm `/__control-plane/health` reports `kernel: own`.
2. Then set the same `KERNEL_COMMAND_SECRET` value in the web app's
   environment.
3. Confirm the switch: the `kernel-floor` cron runs report the control plane as
   their host, `/api/cron/pr-reconcile` reports `kernelSkipped`, and new
   `workflow_transitions` rows from doors carry `host = control-plane`.

**Record (2026-10-17, S8 and the follow-up check).** The switch is made.
Confirmed from outside: the control plane's health reports `mode: own, kernel:
own`, and `/api/deploy-identity` reports the control plane in mode `own` with
`lockstep: true`, on the release then in production (v0.362.0). Not confirmed
(S8 had no database read): the `kernel-floor` cron runs naming the control plane
as host, `/api/cron/pr-reconcile` reporting `kernelSkipped`, and `host =
control-plane` on new `workflow_transitions` rows. Step 3 above stays the check
for those until someone with a read of the table records it.

The other order is safe but does nothing yet: a web host with the secret
follows the Worker's health `kernel` field, which reads `own` only when the
Worker is in own mode and holds the secret, and a Worker without it answers
503 `unconfigured`, on which the web host runs the command itself. The
rollback is the Worker's `EXECUTION_MODE=shadow`, or unsetting the secret on
the web host.

**Acceptance criteria**:
- AC-9: GIVEN `EXECUTION_MODE=own` WHEN a person merges from the dashboard
  THEN the Vercel route submits a landing command, the control plane applies
  T15 and drains the merge effect, and no kernel statement runs in the Vercel
  process (asserted by a host tag on every transition row). The client path
  and the host tags: `apps/web/tests/db/kernel-command-host.test.ts`; the
  dashboard route submitting and applying nothing itself:
  `apps/web/src/app/api/prs/[prNumber]/merge/route.test.ts`. Met for every
  command the web host reaches: each seam command is a door op of the one
  client, and the S3a write-site guard
  (`packages/core/__tests__/workflow-write-sites.test.ts`) fails on any module
  outside the kernel that imports one from the seam.
- AC-10: GIVEN the Vercel project paused WHEN the drain schedule fires THEN
  due effects drain and the floor runs on the control plane
  (`kernel-command-host.test.ts`, `kernel-floor.test.ts`,
  `apps/control-plane/src/index.test.ts`).
- AC-11: GIVEN the same command submitted twice with one idempotency key WHEN
  both arrive THEN one transition is applied and both callers receive the same
  result (`kernel-command-host.test.ts`, `command-api.test.ts`; the kernel's
  half on both stores in the conformance suite).
- AC-12 (failure): GIVEN `EXECUTION_MODE=own` and the control plane
  unreachable WHEN a Vercel door
  submits a command THEN the door answers with a retryable error naming the
  control plane, and applies nothing itself (`kernel-client.test.ts`,
  `kernel-command-host.test.ts`).
- AC-30 (failure): GIVEN `EXECUTION_MODE=own` and a control plane slow to
  answer WHEN a sweep makes door calls and inline drains one after another
  THEN the pass waits on the control plane no longer than its budget, the
  calls past it are refused unsent and retryable, and the pass reports each
  step's time (`kernel-client.test.ts`, and `route.test.ts` beside
  `apps/web/src/app/api/cron/pr-reconcile/route.ts`). GIVEN a command whose
  request died mid-command WHEN the next request with its key arrives a lease
  later THEN it takes the claim over and runs, while a live command's renewed
  claim is never taken over (`command-api.test.ts`,
  `kernel-command-host.test.ts`).
- AC-74 (failure): GIVEN `EXECUTION_MODE=own` and the control plane
  unreachable for a door's whole budget WHEN an attempt end, a reviewer's
  verdict or a CI green is submitted THEN it is parked under its idempotency key, and once the control
  plane answers the floor applies it exactly once (a repeat is answered from
  the ledger); an earlier submission that did apply is settled from the
  ledger without applying it again; one a newer head overtook is refused as
  stale (a verdict) or as for another head (a green) and settled, never
  applied; and a fix claim is never parked (`kernel-command-host.test.ts`,
  `command-outbox.test.ts`, `kernel-client.test.ts`).
  replaces: AC-35

- AC-65 (failure): GIVEN `EXECUTION_MODE=own` and a control plane that is slow
  or hangs WHEN GitHub delivers a webhook whose handler submits a door op
  (`observe_ci_green`, `observe_pr_state`, `observe_head`, `observe_base`)
  THEN the response is back well inside GitHub's ten seconds: each door waits
  at most `WEBHOOK_DOOR_BUDGET_MS` (2.5 s), the request's doors together at most
  `WEBHOOK_BUDGET_MS` (6 s), and a door left unanswered opens a process-level
  breaker (`WEBHOOK_SKIP_MS`, 45 s) so the rest of the request and the
  deliveries after it skip the wait. Nothing is lost: a green, a push and a
  retarget are parked (AC-74), a close is recorded unapplied and healed
  (AC-3), and a kernel-owned PR is never handed to legacy. A door's command key
  derives from the delivery id, the op and the input, so GitHub's redelivery
  of a request that did apply, slowly, is the same command: the ledger answers
  with what was done, and the floor's replay of the parked row applies nothing
  twice. The cap, the request budget and the breaker apply only to doors with a
  durable fallback (`WEBHOOK_CAPPED_OPS`): the parked ops above, `observe_pr_state`,
  and two that are not parked, `observe_ci_failure` and `observe_conflict`, which
  the red-PR sweep and the conflict sweeps re-send. Every other door
  (`open_delivery`, `land`, the rest) keeps its own budget and runs outside the
  webhook's scope: a timed-out `open_delivery` would hand the PR to legacy review
  while the control plane may still finish it, and a timed-out `land` would leave
  a release PR to the held-release sweep. Such a door is never capped, never opens
  the breaker and is never refused for a spent request budget
  (`kernel-client.test.ts`, `route.test.ts` beside
  `apps/web/src/app/api/github/webhook/route.ts`).

Criterion numbering note: the sweep-budget and command-lease criterion in §3
was formerly labeled AC-13 and is now AC-30. The findings criterion in §4
keeps AC-13; evidence tables below reference criteria rather than define them.

Criterion numbering note, second: the Living Spec of this library and `workflow-state-kernel.md`
both own AC-31 to AC-42 (state-kernel §13.13 rules and the review-approval criteria), so this
file's own landing, epoch, projection and open-PR-status criteria, once numbered AC-31 to AC-39,
are AC-70 to AC-78 (31 to 70, 32 to 71, 33 to 72, 34 to 73, 35 to 74, 36 to 75, 37 to 76,
38 to 77, 39 to 78), each with a `replaces:` line. A test tagged AC-31 to AC-42 now means the
Living Spec's criterion of that number.

### Observability

The kernel reports to Axiom, dataset `buildd-traces`, where monitors page the
owner by email and Pushover. Each thing worth an alert is one span with a
stable name and a fixed attribute set (`kernel-telemetry.ts`, pinned by
`kernel-telemetry.test.ts`). On the web host the spans go through the
OpenTelemetry API that `instrumentation.ts` registers (service `buildd-web`).
The control plane has no OpenTelemetry SDK, so its entry installs a sink
(`apps/control-plane/src/axiom-export.ts`) that posts the same spans as
OTLP/HTTP JSON to Axiom's traces endpoint after the response, into the same
dataset, as service `buildd-control-plane`. The sink is installed only when the
Worker holds the secret `AXIOM_INGEST_TOKEN` (an Axiom token with ingest rights
on the dataset). Without it the control plane's spans go to the no-op tracer
and nothing is sent. `AXIOM_TRACES_DATASET` and `AXIOM_OTLP_URL` override the
dataset and the endpoint.

Emitting never throws and never waits. A door call costs one span start and
end, so the claim path's overhead does not change measurably. Custom attributes
are under `['attributes.custom']`; numbers are integers, and ms are rounded.

| Span `name` | When | Attributes |
|---|---|---|
| `kernel.door` | every door call (`door`, the short doors, `doorOrHereOnSkew`), on whichever host ran the door | `kernel.op`; `kernel.outcome` = `applied` \| `parked` \| `unavailable` \| `breaker_open` \| `skew_fallback` \| `refused` \| `failed`; `kernel.latency_ms`; `kernel.budget_ms` (the door's budget, cut to its pass's and, inside a webhook request, to the webhook door cap; a door the webhook does not cap keeps its own); `breaker_open` is a door its breaker skipped (a webhook door is still parked, `kernel.error_code` = `parked`); `kernel.caller` = `webhook` \| `claim` \| `patch` \| `cron` \| `mcp` \| `api` \| `dashboard` \| `other`; `kernel.host` = `web` \| `control-plane`; `kernel.pass` (when inside a budget pass); `kernel.error_code` (the refusal's code, `not_applied`/`unknown` for an unavailable control plane, or `command_failed`) |
| `kernel.breaker` | a breaker opening (the first unanswered door) and closing (the first answered door after it): the AttemptStarted breaker, or the webhook doors' breaker (`withWebhookBudget`) | `kernel.breaker.state` = `open` \| `closed`; `kernel.breaker` = `attempt_start` \| `webhook`; `kernel.op`; `kernel.breaker.skip_ms`; `kernel.breaker.open_ms` (on close); `kernel.host` |
| `kernel.web_command` | a kernel command the web host ran itself through the command client | `kernel.op`; `kernel.reason` = `no_command_key` \| `shadow` \| `not_host` \| `unconfigured` \| `skew`; `kernel.mode` (`own` for the last three: a regression); `kernel.latency_ms`; `kernel.host` = `web` |
| `kernel.pass` | a control-plane budget pass (`withControlPlaneBudget`: a sweep, a webhook) that ran out: a door refused unsent or a drain left to the floor. Not emitted for the short doors' own scope | `kernel.pass`; `kernel.budget_ms`; `kernel.pass.submitted`; `kernel.pass.refused`; `kernel.pass.drains_skipped`; `kernel.pass.waited_ms`; `kernel.host` |
| `kernel.floor` | once per kernel floor run (`runKernelFloor`, either host), after the pass | `kernel.host`; `kernel.outbox.parked` and `kernel.outbox.parked_oldest_age_s` (pending door commands); `kernel.outbox.effects_due` and `kernel.outbox.effects_oldest_age_s` (effects due or past their lease); `kernel.outbox.unread` = true instead when the depth read failed; `kernel.floor.repairs.facts_imported`, `.effects_enqueued`, `.trunk_recovered`, `.treadmill_restarted`, `.parked_answered`, `.parked_dead`, `.total`; `kernel.floor.errors` |
| `kernel.command` | each request the control plane's command endpoint answers | `kernel.op` (`unknown` before the body parsed); `kernel.outcome` = `applied` \| `replayed` \| `failed` \| `refused` \| `unavailable` \| `in_progress`; `kernel.status`; `kernel.error_code`; `kernel.latency_ms`; `kernel.host` = `control-plane` |

The caller is the door's own `DoorCall.caller` when it names one. Otherwise it
is taken from the request's route (the control plane names it per request; on
the web host it comes from the request span), then the budget pass, then the
principal. A door with none of these reads `other`.

Every failed span carries OpenTelemetry status ERROR (`error == true` in
Axiom), except `skew_fallback`, whose command was applied.

Recommended monitors. Each query returns one value `v`, in the style of the
existing `buildd-traces` monitors:

1. **Control plane not answering doors** (threshold: above 10, every 5 min over 15 min):
   ```
   ['buildd-traces'] | where ['resource.custom']['node.env'] == "production" and name == "kernel.door" | extend outcome = tostring(['attributes.custom']['kernel.outcome']) | summarize n = count(), bad = countif(outcome in ("unavailable", "parked", "breaker_open")) | extend v = iff(bad >= 3 and n > 0, 100.0 * bad / n, 0.0) | project v
   ```
2. **A breaker opened** (AttemptStarted or webhook; above 0, every 5 min over 10 min; group by `kernel.breaker` to tell them apart):
   ```
   ['buildd-traces'] | where ['resource.custom']['node.env'] == "production" and name == "kernel.breaker" and tostring(['attributes.custom']['kernel.breaker.state']) == "open" | summarize v = count()
   ```
3. **Kernel command ran on the web host** (above 0, every 10 min over 30 min). This also fires during a deliberate rollback to shadow. To catch only own-mode regressions, add `and tostring(['attributes.custom']['kernel.mode']) == "own"`:
   ```
   ['buildd-traces'] | where ['resource.custom']['node.env'] == "production" and name == "kernel.web_command" | summarize v = count()
   ```
4. **Doors slow** (p95 above 5000 ms, every 5 min over 15 min; the claim's start is bounded by its own budget and the breaker):
   ```
   ['buildd-traces'] | where ['resource.custom']['node.env'] == "production" and name == "kernel.door" and tostring(['attributes.custom']['kernel.caller']) != "claim" | extend ms = toint(['attributes.custom']['kernel.latency_ms']) | summarize n = count(), p = percentile(ms, 95) | extend v = iff(n >= 5, p, 0.0) | project v
   ```
5. **Doors refused or failing** (a bug, not an outage; above 2, every 10 min over 30 min):
   ```
   ['buildd-traces'] | where ['resource.custom']['node.env'] == "production" and name == "kernel.door" and tostring(['attributes.custom']['kernel.outcome']) in ("refused", "failed") | summarize v = count()
   ```
6. **Parked door commands waiting** (oldest above 7200 s, every 15 min over 75 min, so the last hourly floor is always in range):
   ```
   ['buildd-traces'] | where ['resource.custom']['node.env'] == "production" and name == "kernel.floor" | summarize v = max(toint(['attributes.custom']['kernel.outbox.parked_oldest_age_s']))
   ```
7. **Kernel effects backed up** (oldest due above 1800 s, every 15 min over 75 min):
   ```
   ['buildd-traces'] | where ['resource.custom']['node.env'] == "production" and name == "kernel.floor" | summarize v = max(toint(['attributes.custom']['kernel.outbox.effects_oldest_age_s']))
   ```
8. **Floor repairing missed events** (above 3, every 15 min over 75 min; each is a webhook or effect row the live path lost):
   ```
   ['buildd-traces'] | where ['resource.custom']['node.env'] == "production" and name == "kernel.floor" | summarize v = max(toint(['attributes.custom']['kernel.floor.repairs.facts_imported']) + toint(['attributes.custom']['kernel.floor.repairs.effects_enqueued']))
   ```
9. **Parked commands given up, or the floor failing** (above 0, every 15 min over 75 min):
   ```
   ['buildd-traces'] | where ['resource.custom']['node.env'] == "production" and name == "kernel.floor" | summarize v = max(toint(['attributes.custom']['kernel.floor.repairs.parked_dead']) + toint(['attributes.custom']['kernel.floor.errors']))
   ```
10. **Floor not running** (below 1, every 30 min over 130 min; needs the control plane's token, since the floor runs there in own mode):
    ```
    ['buildd-traces'] | where ['resource.custom']['node.env'] == "production" and name == "kernel.floor" | summarize v = count()
    ```
11. **Control-plane commands failing** (above 3, every 5 min over 15 min):
    ```
    ['buildd-traces'] | where ['resource.custom']['node.env'] == "production" and name == "kernel.command" and tostring(['attributes.custom']['kernel.outcome']) in ("failed", "unavailable") | summarize v = count()
    ```
12. **Control-plane commands slow** (p95 above 5000 ms, every 5 min over 15 min):
    ```
    ['buildd-traces'] | where ['resource.custom']['node.env'] == "production" and name == "kernel.command" and tostring(['attributes.custom']['kernel.outcome']) in ("applied", "replayed") | extend ms = toint(['attributes.custom']['kernel.latency_ms']) | summarize n = count(), p = percentile(ms, 95) | extend v = iff(n >= 5, p, 0.0) | project v
    ```

Monitors 2, 6 to 12, and the door monitors for doors the control plane runs
itself (claims, worker PATCH and webhooks served there), report nothing until
the Worker holds `AXIOM_INGEST_TOKEN`.

## 4. One landing authority

**Capability statement**: Every path by which a PR reaches trunk MUST pass the
kernel's landing gate at merge time, and a merge buildd did not make MUST be
recorded as such, never as an approval.

**Invariants**:
- The door inventory is `workflow-state-kernel.md` §13.13 D1–D13. Each door
  either submits a landing command (§3) or is closed. The release doors (PR on
  CI green, release executor, release compose) take the review gate and pin
  the head they verified; the release executor's two unpinned merges are
  pinned.
- The gate is evaluated in the merge effect itself, against a fresh read of the
  head, base, CI, open findings (§5) and policy, not trusted from the door
  (today's `rails: {passed:true}` is removed). `evaluateAutoMergeSafety` and
  `guardMissionPrMerge` become rail inputs the kernel reads, not separate
  gates a door may skip.
- A PR with no delivery is not merged by a buildd door. A door asked to merge
  one opens (or adopts) its delivery first; "legacy" merges end at slice S3.
- GitHub enforces the verdict: on every kernel-owned PR head the kernel's
  `publish_landing_status` effect publishes the commit status
  `Buildd / Review approval` (also under its former name `buildd/landing`,
  written with the same answer until nothing reads it). It is `success` only
  when the kernel would land that head (approved or landing, covered, no open
  verdict), `pending` while review of that head has not finished (so ongoing
  review never reads as failing CI), and `failure` while a required finding is
  open, a verdict stands against the head, or a person has to decide. Its
  description leads with one plain term (R-43): "Review in progress",
  "Changes requested", "Unresolved review finding: <the finding>", "Ready to
  merge" or "Merge blocked: <reason>", clipped to GitHub's 140 characters; it
  never says "land" (internal names keep it). Its target URL is the host's
  page for the delivery's review and findings (the optional `Links` port;
  buildd links the owner task's review findings, `/app/tasks/<id>#review-findings`
  on the app's public name, which opens the Code review row to them), so
  GitHub's Details link is somewhere a person can act. `get_pr` prints the same description on
  its own `Review approval:` line, apart from `CI:`. One effect per delivery version; only the newest
  version's effect publishes, so a late or duplicate effect never overwrites a
  newer answer, and an effect that runs out of retries publishes `failure`,
  never leaves a success standing. It is one GitHub App and one commit-status
  check, separate from CI: no second App and no native GitHub self-approval.
  CI is not part of it: CI has its own checks,
  and the merge rails never read either name as CI. Making `Buildd / Review approval` a required
  check on trunk is an owner decision (today `main` requires `build` and
  `release candidate verified`, `dev` has no rule, and admins are not
  enforced, so a manual GitHub merge on `dev` over an open finding is not
  blocked; it is recorded as an external merge, AC-15), taken once every open PR carries it.
- The verdict is the kernel's record for one commit and round, never the GitHub
  review's state or prose. buildd's App opens the PRs it reviews and GitHub
  refuses it an approval or request-changes on them, so such a review is posted
  as a comment and reads COMMENTED whatever it says; nothing reads that state,
  or the words in its body, as a verdict (`github-approval.test.ts`). Native
  approve / request-changes are used when the reviewing account is not the PR's
  author; otherwise the review body says so, in a fixed note, and the merge is
  gated on the kernel verdict alone. Every posted review ends with a line
  naming its verdict, head and round, and, when it replaces an earlier decision,
  that decision: `supersedes the approval of <sha> (round N)`, `clears the
  request for changes of round N at <sha>`. A verdict that blocks a head its
  own `verdict` approval covered withdraws that approval (`approved_heads`
  emptied, `approval_basis` cleared, recorded in the transition's evidence as
  `withdrewApproval`); a person's approval is theirs to withdraw. An approval
  at one commit never covers another: the review status of a head whose
  predecessor was approved says "the approval of <sha> does not cover it", and
  a blocking status after an approval says it supersedes it
  (`review-verdict-authority.test.ts`). A new blocking finding in code the
  reviewer already approved is reported as a finding, never absorbed; the
  reviewer prompt asks for edge-case tracing and every blocking issue in the
  one review, to keep rounds to what is new.
- A person's approve-and-override (§7) is a human approval of exactly the
  current head, so `Buildd / Review approval` is `success` for that head and
  says so: "Ready to merge: <sha> approved by a person over N open findings".
  A later push starts it `pending` again, like any approval. The findings
  stay as they were; only the check and the landing read the approval.
- A merge GitHub holds on a required check is a wait, never a person's (merge
  holds). GitHub's 405 "Required status check ... is expected / in progress /
  pending" is the outcome `held`, not a refusal: the delivery stays `LANDING`
  with its approval standing, nobody is notified, and the merge is asked again
  with backoff and as soon as a check reports on that head. Only a hold that
  outlives its bound, or one on `Buildd / Review approval` for a head the
  kernel will not turn green (a person's override past the review), is
  `ESCALATED(landing_needs_human)`, naming the check. A failing required check
  stays a refusal. The merge is never asked for before the head's own
  `Buildd / Review approval` success is on GitHub and read back. The release
  doors hold on the same answer instead of failing the release.
- Every open PR head in a linked repo carries `Buildd / Review approval`,
  not only a kernel-owned one, so a required check never waits on a context
  nothing will publish (AC-76). A head the kernel answers for (a live
  delivery at that head) gets the kernel's answer above, written by its own
  effect. A frozen release candidate gets the release gate's answer at its
  SHA: `success` only when every required candidate check passed on that SHA
  and buildd's review gate for releases does not hold it, `failure` when a
  required check failed there or a review stands against it, `pending`
  otherwise. Any other open head (a PR no delivery owns, such as a dependency
  bot's or a draft; a push the delivery has not seen yet; a delivery that is
  over while its PR stays open) is `pending`, "Review not requested" or
  "Review in progress", and never `success`: only a delivery's gate says a
  head may merge. A success given to one head never carries over to another
  (AC-77).
- A merge observed by webhook that no buildd door made is recorded as an
  external merge: `MERGED` with the merger, the head, and
  `merged_over_open_findings` when any were open, plus a fix task against
  trunk for those findings (§13.13 rule 10): filed only for changes asked of
  the head that merged (not for an escalation a person resolved by merging,
  nor a verdict on an older head). It is never projected as
  "approved". `measureMergeAgainstReview` keeps recording the bypass.
  Every buildd door lands a kernel PR through `LANDING`, so "external" is a
  `PrMerged` from any other state. An open finding is an open required
  finding of §5; the newest decided review round asking for changes or
  escalating still counts as an open verdict beside it.

**As built (S3b):**
- The gate is `reviewGate` (`packages/workflow-kernel/src/landing-gate.ts`)
  plus the `Rails` port (`apps/web/src/lib/workflow/auto-merge-rails.ts`:
  `evaluateAutoMergeSafety` with freshness left to T15, and the mission-PR
  hold). `merge_call` reads the PR live first: merged or closed goes to the
  funnel, a moved head is recorded and nothing merges (AC-14), then review,
  base (a retarget is recorded like a moved head) and rails. Only a human
  actor's own landing is a person's: it is held to red CI and protected paths,
  and may merge on pending CI but never on red; the unattended rails (size cap,
  migration inspector, semantic hold) apply to every other landing. An agent
  acting under a person's grant is not a person: the grant lifts only the rail
  it names (freshness at T15, size in the size check).
  A refusal is T16 `gate_refused`: a rail that clears by waiting (pending CI, a
  hold) leaves the approval standing (`APPROVED`); a lasting one (protected
  path, migration, size) and the review half are `ESCALATED(landing_needs_human)`,
  notified, with the rail named on `Buildd / Review approval` ("Merge blocked:
  <rail>"). A rail's refusal reason is passed through verbatim, so the rails
  word it in merge terms and never say "land" either; the mission delivery
  pills read the shared terms catalog ("Merging", "Merged", "Closed without
  merging") and the page's action says "Retry merge". The status is written only when GitHub does not already show it
  (state, description and, when the reader reports it, the link), and re-checked after writing so the
  newest version wins across drains. The mission-PR hold is a rail too, and
  lasting when only a person or a new fact changes it: a refresh on a branch it
  was not filed for, or a task PR on a shipped delivery with no current one to
  move to. A door that reads such a hold hands a kernel-owned PR to the kernel
  anyway, so the merge-time rails escalate it once; it never merges it on a
  legacy arm, and the sweep stops asking once the delivery is `ESCALATED`.
  Every door and the rails ask the hold of the task the PR was opened for,
  never a repair attempt pushing to it (`deliveryOwnerTask`): an attempt carries
  none of a refresh's context, which is how the sweep passed #4909 while the
  merge-time rails refused it on every pass.
- Release doors hold, never fail or throw, when a kernel-owned PR is not landed
  yet or the control plane does not answer; a PR the kernel does not own never
  reaches the kernel. A lost GitHub answer is indeterminate, not a refusal.
  A held release task records its PR and merge method (a held worker PR
  squashes) and is settled by the PR: completed when it merges by any door,
  failed with the reason when it closes unmerged. The hourly pr-reconcile
  merge-state pass (and the daily full pass) sweeps held tasks (`apps/web/src/lib/held-pr-tasks.ts`): a merged or closed
  PR settles, a green open one is retried through the release-on-green door,
  and a task still held after 24 sweeps fails with the reason.
- Merge holds (`packages/workflow-kernel/src/merge-hold.ts`): the host reads
  GitHub's answer with `requiredCheckHold` (`apps/web/src/lib/required-check-hold.ts`)
  into `MergeAnswer { outcome: 'held', check }`. `merge_call` parks its own
  outbox row (no attempt spent, outcome `held:required_check:<check>`), due
  again after 30 s doubling to 10 min with the row's age (`ClaimedEffect.ageMs`,
  the store's clock), so the floor drain retries it with no wake. At
  `MERGE_HOLD_MAX_MS` (2 h from the landing request) it applies T16 `held`
  with `lasting`, which escalates and names the check on the status and in the
  notice; a `held` that is not lasting returns to `APPROVED`. Before the merge
  call, `merge_call` publishes the head's `success` under both names when
  GitHub does not already show it and reads it back; a success GitHub does not
  show yet parks the row the same way (`held:own_status:…`). A green check
  suite (`observeCiGreen`) or a commit status `success` on a `LANDING` head
  (the webhook's `status` case, buildd's own contexts skipped) wakes the held
  row (`Store.wakeHeldMerges`) and drains the delivery where the kernel is
  hosted. A door asking meanwhile is told the merge is held and on what
  (`reason: merge_held`). Release doors: `mergeReleasePrPinned` answers
  `refused: 'required_check'` with `hold: true`, so the release executor
  returns `pending_ci`; the release-on-green door leaves the task held. A held
  release is bounded by the held-release sweep above. The GitHub App must be
  subscribed to the Commit status event for the `status` wake; without it the
  check-suite wake and the backoff still retry.
- Release doors D7–D10 go through `apps/web/src/lib/release/pinned-merge.ts`
  (or the kernel, for a PR it owns): live read, refuse a head other than the
  verified one (AC-16), `guardReviewVerdict` at that head, GitHub's `sha` pin.
- Events publish it without waiting for the floor (AC-78):
  `publishOpenPrHead` (`apps/web/src/lib/workflow/open-pr-status.ts`), called
  through `republishPrHeads` (`open-pr-events.ts`) from the `pull_request`
  (opened, reopened, synchronize, ready_for_review), `check_suite` and
  `check_run` webhooks, a stored review request (`createReviewerTask`) and a
  recorded review verdict; the routes reach it through `republishPrHeads` in
  `apps/web/src/modules.ts` (S14). A check event or a review request can only
  move a release candidate's answer, so it reads only a PR that can be one
  (the workspace declares candidates and its branches fit). It derives the
  answer from what GitHub and the review state show now, never from the event,
  skips a PR that is closed or whose head is not the event's, writes only when
  GitHub shows something else, and derives again after writing, so duplicate
  and out-of-order events leave the newest answer and a failing re-run or a
  later verdict flips a verified candidate at once. On the web host it writes
  commit statuses only; a head a delivery owns is republished by the kernel
  through its own door and by the floor, never by this path.
- Every open PR carries it (AC-76, AC-77): `openHeadStatus`,
  `releaseCandidateStatus`, `unownedPrStatus` and `statusCoverage`
  (`packages/workflow-kernel/src/open-pr-status.ts`) decide; the host's
  `publishOpenPrStatuses` (`apps/web/src/lib/workflow/open-pr-status.ts`) is a
  step of the kernel floor, so it runs hourly wherever the floor runs and its
  first pass is the one-off republish onto heads opened before the context
  existed. It lists each linked repo's open PRs (drafts included, up to 300 per
  repo). A kernel-owned head showing something other than the kernel's answer
  gets a `publish_landing_status` effect at the delivery's version (key
  `landing_status:<delivery>:<version>:open-pr-sweep`), drained at once, so the
  effect's newest-version rule decides the write and the sweep never writes a
  kernel head itself. Other heads are written by the host, under both names,
  only when GitHub shows something else; if a delivery took the PR while the
  host wrote, the kernel republishes after it. The review reads (was a review
  asked for; a candidate's checks and review verdict, using the pure
  `evaluateReviewVerdictGate` so a sweep records no gate event) are the
  releases module's (`apps/web/src/lib/release/open-pr-review.ts`), reached
  through the composition root. Coverage is re-read on every head after the
  pass: each head still without the context is an error of the floor's
  `kernel-floor` run, and a pass that read no head reports `nothing_checked`,
  never covered. Not yet: a webhook trigger, so a new PR or a candidate whose
  checks just finished waits for the next floor tick; until then the
  context is absent or pending on it, never a stale success.
- D4 refuses when no workspace resolves; D5 `force` no longer skips the review
  verdict. `apps/web/src/lib/workflow/merge-door-inventory.test.ts` fails on
  any merge call not in the inventory.
- A PR with no delivery is adopted before a worker door merges it (AC-13,
  #4686): `adoptBeforeMerge` (`apps/web/src/lib/pr-landing-adoption.ts`)
  runs in D2/D3 `landPr` (when it acts), D4 `tryAutoMergeWorkerPr`, D5
  `merge_pr` and D6 the dashboard merge, before the door reads who owns the
  PR. With no delivery row it calls `open_delivery` with the door's task
  (an attempt walked to its owner) and the door's principal; the delivery
  starts as a late open does (the owner's end forwarded, a review of the live
  head owed), so the door lands it through T15 and a legacy reviewer's
  approval never carries it. Before opening anything it reads the PR live: a
  release PR (`classifyReleasePr`: the legacy release branch, or a trusted
  frozen candidate) or a dependency bot's PR opens no delivery, even when a
  bookkeeping task owns it (`ci-failure-retry.ts` and `request_pr_review`
  give a PR with no worker one). The door merges such a PR through the release
  gate (`mergeOutsideKernel` → `mergeReleasePrPinned`: review gate at the
  head, GitHub's `sha` pin), so a candidate keeps `releaseCandidateStatus` and
  no kernel repair ever pushes to a candidate's or a bot's branch. A fork PR
  cannot be bound, so it is refused at every buildd door, the dashboard
  included: a fork PR merges only on GitHub. If nothing can adopt a PR (a
  fork, no task, a review or attempt task, a task bound to another PR, a PR
  that cannot be bound or read, the control plane unreachable) the door merges
  nothing and says why. Its legacy
  merge call is reached only when the workspace's kill switch is off or the
  PR's delivery was released to legacy (sticky, §14); an adopted PR whose
  landing the kernel does not answer is refused, never merged on that arm.
  `merge-door-inventory.test.ts` holds each of these doors to it.
- Deviation: the release doors D7–D10 do not adopt. A release PR with no
  delivery merges under the release gate above (`pinned-merge.ts`: review
  gate, verified head, `sha` pin), because its bookkeeping (the held release
  task, the release record and its candidate status) lives outside the kernel;
  moving it is an owner decision.

**Acceptance criteria**:
- AC-13: GIVEN a PR with an open required finding WHEN any of D1–D11 is asked
  to merge it THEN the merge is refused with the finding named, and the
  `Buildd / Review approval` status at that head is `failure` reading
  "Unresolved review finding: <the finding>".
- AC-14: GIVEN an approval at head A WHEN head B is pushed before the merge
  effect runs THEN the effect re-reads, sees B, and does not merge.
- AC-15: GIVEN a person merges on GitHub over an open finding WHEN the webhook
  arrives THEN the delivery is `MERGED` with `merged_over_open_findings`, a
  trunk fix task is filed once (idempotent on replay), and no surface shows
  "approved".
- AC-16 (failure): GIVEN the release executor merging a release PR WHEN its
  head moved after verification THEN the merge is refused, not merged
  unpinned.
- AC-70 (failure): GIVEN an approved kernel-owned PR whose mission-PR hold is
  lasting WHEN the sweep or any door asks to land it THEN the delivery is
  `ESCALATED(landing_needs_human)` once with the hold named, nothing merges,
  and the sweep does not request landing again for that head; a CI-fix
  attempt's worker on the PR gets the same answer as its owner.
  replaces: AC-31
- AC-75 (failure): GIVEN an approved kernel-owned PR WHEN GitHub refuses the
  merge because a required check has not passed yet THEN the delivery stays
  `LANDING` with the approval standing and nobody notified, the merge is asked
  again once a check reports on that head (or after its backoff), and only a
  hold past its bound is `ESCALATED(landing_needs_human)` naming the check; the
  merge call never runs before the head's own `Buildd / Review approval`
  success is on GitHub; a release door holds the release on the same answer
  instead of failing it.
  replaces: AC-36

- AC-76: GIVEN open PRs in a linked repo with no delivery (a dependency bot's,
  a draft), a kernel-owned PR whose head shows a status other than the
  kernel's answer, and a frozen release candidate WHEN the kernel floor runs
  THEN each head carries `Buildd / Review approval` (pending "Review not
  requested" / "Review in progress", the kernel's answer through its own
  effect, the release gate's answer at the candidate SHA), a second pass
  writes nothing, and a head still without it is listed and counted as an
  error of the run.
  replaces: AC-37
- AC-77 (failure): GIVEN a head approved at H1 WHEN H2 is pushed and the
  kernel has not seen it, or the delivery is over while the PR stays open,
  THEN the open head's status is `pending`, never H1's `success`; a release
  candidate is `success` only with every required check passed on its SHA
  and no review standing against it.
  replaces: AC-38
- AC-78 (event; implements Living Spec criteria AC-40 and AC-42 of the
  workflow kernel spec): GIVEN a PR opened or pushed, or a release candidate's
  check re-run, review requested or review verdict changed WHEN the event
  arrives THEN the head's status is rewritten at once to the answer true now
  (a verified candidate flips to `failure` or `pending`), a duplicate or older
  event changes nothing, and a check event on a PR that cannot be a candidate
  reads nothing from GitHub.
  replaces: AC-39

| AC | Test |
| --- | --- |
| Criterion AC-78 | `apps/web/src/lib/workflow/open-pr-head.test.ts`; `apps/web/src/lib/reviewer.test.ts` › "a stored review request republishes"; `apps/web/tests/db/workflow-open-pr-status.test.ts` › "AC-78" |
| Criterion AC-75 | `packages/workflow-kernel/src/conformance/scenarios.ts` › "merge holds"; `packages/workflow-kernel/src/merge-hold.test.ts`; `apps/web/src/lib/workflow/pr-landing-effects.test.ts` › "a required check that has not passed yet is a hold"; `apps/web/src/lib/release/pinned-merge.test.ts` › "§4 merge holds"; `apps/web/src/app/api/github/webhook/route.test.ts` › "§4 merge holds" |
| Criterion AC-76 | `apps/web/tests/db/workflow-open-pr-status.test.ts`; `apps/web/src/lib/workflow/open-pr-status.test.ts`; `apps/web/src/lib/workflow/kernel-floor.test.ts` › "open PR status coverage"; `packages/workflow-kernel/src/conformance/scenarios.ts` › "AC-76" |
| Criterion AC-77 | `packages/workflow-kernel/src/open-pr-status.test.ts`; `apps/web/tests/db/workflow-open-pr-status.test.ts` › "AC-77"; `apps/web/src/lib/workflow/open-pr-status.test.ts` › "AC-77" |
| Criterion AC-70 | `apps/web/src/lib/pr-landing.test.ts` › "a lasting delivery-target hold"; `apps/web/src/lib/workflow/auto-merge-rails.test.ts` › "#4909"; `apps/web/src/lib/mission-pr.test.ts` › "a CI-fix attempt on a refresh PR"; `packages/workflow-kernel/src/conformance/scenarios.ts` › "a lasting rail" |

## 5. Findings that survive

**Capability statement**: A required review finding MUST keep a stable
identity and an explicit disposition until a current review verifies it, so no
push, refresh, completion or owner change can make it disappear.

**Invariants**:
- Findings follow `workflow-state-kernel.md` §13.13 rule 2 (durable, pinned to
  round, head, path and line; closed only by a resolving round, a person's
  waiver, or the PR closing unmerged, when the finding moves to the
  superseding PR). This spec adds two things to rule 2, and §13.13 is amended
  to match in slice S5:
  - a stable id across rounds (derived from the delivery, the originating
    round and its position, carried forward when a later round restates it);
  - an interim disposition `addressed` (a push touched the finding's path and
    awaits verification) beside `open`, and `deferred` as a fourth closure (to
    a named task, accepted by a reviewer or a person, recorded with who and
    why). `addressed` is not closed: approval still needs a round that
    resolves it.
- A builder's completion, a push, green CI, a branch refresh, a task
  completion or an owner replacement never closes a finding.
- A repair is a pinned builder: its description is the open findings, its
  target is the delivery's branch, head and base (`repairTarget`), and it
  never inherits a coordination owner's instructions (§13.13 rule 3).
- Completion evidence is §13.13 rule 4: a repair completes only on a push
  to the PR head that changes at least one path named by an open finding (or
  a path the reviewer's feedback names), or on a verified no-op (a live read
  at the current head showing the finding's condition is already absent,
  recorded as evidence). A zero diff, a diff that touches none of the
  findings' paths, or a head that moved only because of a refresh or someone
  else's push is refused, the attempt counts against the round limit, and
  every surface shows it as "no change", never "fix finished".
- The activity comment and `get_pr` / `get_pr_review` list findings with their
  disposition, the commit that addressed each, and the round that verified it.
  "Fix attempt n of m" counts attempts, never findings.

**As built (S5, findings half):**
- Findings live in `workflow_findings`, written only by the transition
  statement (`FindingOp`, `packages/workflow-kernel/src/findings.ts`). The id
  is `<originating round id>:<ordinal>`; a round that restates a finding names
  that id and the row is updated, never duplicated.
- A request for changes raises the reviewer's `findings` (one per issue, with
  path and line). With none, one finding stands for the round ("the review
  asked for changes"), so a request for changes always leaves something open.
  That stand-in has no id a reviewer is likely to report, so an unscoped
  approval verifies it when it reviewed a later head than the one asked to
  change, or when it verified every structured finding still open.
- A deferral names a task by its full id. The host resolves a reviewer's id
  against the delivery's workspace (`resolveDeferralTasks`): a full id must be
  a task there, a short id must prefix exactly one. A deferral whose task does
  not resolve (none, another workspace's, an ambiguous prefix), or that names
  none, closes nothing and is recorded as `unresolvedDeferrals` on the
  verdict's transition, which still applies. A person's deferral with a task
  id that is not a full one is refused (`deferral_task_unresolved`). The
  Postgres adapter never casts anything but a full id to a uuid column, so no
  write can abort a verdict's transition.
- The reviewer is briefed with every open finding and its id
  (`findingsBrief`, `findingsSection`) and reports `resolvedFindings`,
  restated `findings` and `deferredFindings`. A reviewer output with no
  `resolvedFindings` key (an older reviewer) approving an unscoped round
  verifies every open finding, since all of them were in its brief. A scoped
  round (a composition's novel paths, a refresh) verifies only what it names.
- An approval that leaves a required finding unverified does not approve the
  head: the round is decided as the reviewer said and a verification round at
  the same head (scope `verifyFindings`) is queued, or `review_exhausted` at
  the round limit. `reenterVerdict` applies the same rule when a held or
  earlier verdict is re-entered.
- `addressed`: a push observed by T3, or a repair's delivered head at T4,
  whose compare against the previous (or bound) head lists a finding's path.
  The compare is read only when an open finding names a path. A mechanical
  repair's head and an own refresh never address anything (rule 5).
- A person's `FindingDisposed` (waived, or deferred to a named task) closes
  one finding with who and why; an agent is refused.
- The dashboard submits it: a person-only command-API op (`dispose_finding`)
  and `POST /api/prs/[prNumber]/dispose-finding`, from the escalation card,
  bound to the head and version the card showed (the same decision again is one
  transition; a finding a later round restates is a new decision). A duplicate
  reads as success only while the finding is closed the way asked.
- Deviation: no MCP action submits `FindingDisposed` yet, and the route reads
  only the cookie session. A finding on a changes-requested PR that is not
  escalated cannot be waived from the dashboard; the reducer accepts it in any
  state. Who may waive is workspace membership, as for a re-review.
- The landing gate (`reviewGate`), T15, the policy-merge rule (D11) and
  `buildd/landing` read open required findings and name the first
  one. Only a person's verdict override or their own approval of the head
  passes one. An external merge records `merged_over_open_findings` for an
  open finding even when the newest round approved, and the trunk fix names
  the findings.
- The activity comment lists every finding with its disposition, the commit
  that addressed it and the round that verified it (`renderFindingsSummary`);
  `DeliveryView` carries `findings` and `openFindings` for S7.
- Existing deliveries have no findings: their open verdicts keep blocking
  through the newest decided round, as before.
- Deviation: a finding of a PR that closes unmerged is not moved to the
  superseding PR yet; it stays on the closed delivery.

**As built (S5, pinned repair builders and completion evidence):**
- A review fix (`fixWork`) is a builder: its role is `builder` when the owner
  has none or is coordination-only, its kind `engineering`. Its description is
  the open findings with their ids, then the reviewer's feedback, then where to
  push and how completion is judged (`pinnedFixDescription`); the owner's
  description is background only and a coordination or bookkeeping owner's is
  never copied. Its `repairTarget` is the PR head GitHub reports. A kernel CI
  fix takes the same role rule and `repairTarget`.
- Completion (`fixCompletionGate`, role `fix`), a moved head: refused
  (`repair_unrelated_diff`) only when the diff plainly cannot answer the
  findings (`diffTouchesFindings`): every open required finding names a path,
  and the push changes nothing in any finding's directory or below it,
  nothing with the same stem as a finding's file (its test), and no path the
  reviewer's feedback names. A rename counts under its old name. The check is
  deliberately wide: a fix often lands beside the line the reviewer pointed at
  (a test, a caller, a callee), and refusing a real fix costs a whole attempt,
  while letting an unrelated push through costs one re-review that finds the
  finding still open. It is skipped when an open finding has no path (nothing
  to compare), for a person's applied fix (T23), and for an explicit claim
  `structuredOutput.fixedElsewhere { findingIds, files, reason }` naming open
  findings, which the re-review verifies like any fix. An unread compare is
  not evidence either way.
- Completion, an unmoved head: refused unless the fix claims a verified
  no-op (`structuredOutput.noopEvidence { findingIds, evidence }` naming an
  open finding). A no-op claim on a moved head excuses nothing.
- Remaining rule-4 deviations: a fix in another directory than the
  finding's, with nothing the feedback names, needs the `fixedElsewhere`
  claim; a finding on a file at the repository root accepts any change (its
  directory is the root); the gate does not tell a refresh push credited to a
  running fix (§6.9) from the fix's own; legacy review fixes have no gate.
- A no-op claim never resolves anything: the attempt ends `noop` (it spends
  the budget) and a verification round at the same head checks the named
  findings. A fix that ends with the head where it was bound (read live; an
  unread head is a failure) ends `noop` too,
  and the next attempt is owed. Every surface reads `noop` (and `unproven`) as
  "no change" (`task-checks.ts`).

**As built (S5, the review loop never stalls):**
- A verdict is never dropped because the builder is still open (00d288fd). A
  reviewer that ran outside the kernel's rounds (filed by a door before the
  delivery opened) is adopted at the head it judged (`ReviewVerdictAdopted`):
  while the owner works, a repair holds or trunk is red, and the kernel has
  asked no reviewer of its own, it is kept as a decided round and the
  hand-off applies it. It is never posted to GitHub as a review. The kept
  round is a round like any other: it uses one of the delivery's `maxRounds`
  (unless it re-checks a head after an approval, which spends none:
  workflow-state-kernel.md §8.2, c1d66a6a).
  The kept approval covers only the head it judged: approved at H1, and the
  owner pushes H2 and ends, H2 is reviewed and does not land on H1's word. When the
  owner's end leaves the delivery `APPROVED` at the same head, the seam marks the PR
  due on the landing sweep's queue, so landing is re-evaluated at once instead of
  waiting for a person or the floor (the landing door had deferred while the delivery
  was `WORKING`, and nothing else woke it).
  It does not skip a CI repair: an owner hand-off on a red head goes to
  `REPAIRING(ci)` first, and leaving the repair re-enters the kept verdict. The kernel's
  own open round at that head is never answered from outside (its reviewer
  does), and a verdict on another head is stale. The same head is never reviewed twice for it, and `explain`
  calls an open reviewer a review, never "Fix 0 of 3".
- A push after an escalation that touches a finding's path marks the finding
  `addressed` (AC-17's interim disposition), held deliveries included. No
  review is queued for it while the hold stands, but the person sees it: the
  review line reads "2 open findings, 1 with a fix waiting for a re-review" and
  the escalation detail says how many have a fix waiting (c1d66a6a).
- Completing a fix arms a delta re-review at the new head (1bd26ae7). A fix
  that pushed from somewhere the runner cannot see reports no local head; its
  proof is §9's "L unknown" rule (the head moved off the bound head; a
  rebase and force-push does not descend from it, so ancestry is not asked), only when nothing local can be lost: a completed end or
  one with no commits (AC-10). An unproven end with commits waits for its push. A `dispatch_review` that cannot file a reviewer fails its
  round (T27, re-queued twice with a backoff, then `review_unavailable`)
  instead of leaving it open with nobody on it. A re-queued dispatch is due
  minutes later but runs only when something drains: an event on the delivery
  or the hourly floor. Nothing schedules a drain for it, so on a quiet PR
  `review_unavailable` arrives within about two floor ticks of the first
  failure (up to about two hours), and until then `request_pr_review` answers
  that a review is in flight (a81a100f). Each retry's backoff stays under one
  floor period, so neither retry waits a tick longer than that
  (`kernel-floor.test.ts`).
- A moved head names the repair tasks it made moot in `cancel_open_attempts`
  (`taskIds`), so a retried effect never cancels a newer one. A mechanical
  repair has no task: it names none and cancels nothing (a81a100f). An agent
  row not yet linked to its task, and an effect recorded before `taskIds`
  existed, keep the role-wide cancel.
- `request_pr_review` never claims a review exists when none does: an open
  round with no reviewer task whose dispatches all finished gets its dispatch
  again (the floor's rule, run for the asker), and the answer says what is
  queued (`queued`) rather than "already under review" with no state.
- A green CI observation at the head that went red ends the CI repair bound
  to it (38442d17, `CiGreenObserved`, from the `check_suite` success webhook
  and the red-PR sweep, read live). Green means every check suite on the
  head passed (GitHub's passing allow-list, `ciGreen`) and its check runs all
  completed with none failing; a cancelled, stale or action-required run is
  not green. A queued attempt is skipped (it spent nothing), a running one is
  cancelled and exactly its task told to stop, and the
  delivery returns to what the head was owed before (`APPROVED` for an
  approved head). Classifying a pre-test infrastructure failure so no CI fix
  is dispatched at all is not built: the green re-run is what clears it.

**Acceptance criteria**:
- AC-17: GIVEN two findings at head A WHEN a fix push touches one finding's
  path and a migration-only push follows THEN one finding is `addressed`, the
  other `open`, and approval at the latest head requires a review that
  verifies the addressed one (the #4679 sequence).
- AC-18: GIVEN open findings on a mission PR WHEN its coordination owner is
  replaced and the branch is refreshed THEN the findings are unchanged.
- AC-19 (failure): GIVEN a repair that ends with zero diff and no verified
  no-op evidence WHEN it tries to complete THEN completion is refused, the
  attempt counts against the round limit, the findings stay `open`, and the
  attempt is shown as "no change".
- AC-66 (implements Living Spec criterion AC-44): GIVEN a delivery held
  `ESCALATED(review_exhausted)` with two open findings WHEN a push touches one
  finding's path and CI goes green on it THEN that finding is `addressed`
  (awaiting verification) and the other `open`, nothing is verified, no review
  or fix is dispatched, nothing merges, and the delivery stays the person's.

Counting (Living Spec r7 §7, task 59f2c591). Every surface counts findings
from one partition, `findingTotals`: each required finding is in exactly one
of `open`, `addressedAwaitingVerification`, `verifiedResolved`, `waived` and
`deferred`; optional findings are counted apart as `advisory`. A pushed fix is
never counted as verified, and a waived or deferred finding is never counted
as resolved. `open + addressedAwaitingVerification` is what blocks landing.

| AC | Test |
| --- | --- |
| Criterion AC-66 | `packages/workflow-kernel/src/conformance/scenarios.ts` › "r7 AC-44"; `apps/web/tests/db/escalation-decisions.test.ts` › "AC-44 / AC-47" |

## 6. Mission deliveries and epochs

**Capability statement**: A mission-branch mission MUST be a sequence of
kernel-owned delivery epochs, so shipping one epoch never strands the mission's
later work and nothing refreshes or re-ships a branch that already landed.

**Invariants**:
- A mission's integration PR is a delivery of role mission, opened when the
  branch is cut (today `openMissionIntegrationPr`, which opens it itself rather
  than waiting for the `opened` webhook, so the merge policy tier does not decide
  whether a mission PR has one). #4686 is the case of a mission PR with none.
- Epochs (task f3bda4e1): `workflow_mission_epochs`, one row per epoch (one
  integration branch and, once its work is in, one PR into trunk), written only
  by the kernel. The transition table is the package's
  (`packages/workflow-kernel/src/delivery-epochs.ts`, `reduceMissionEpochs`);
  the host applies each transition as one statement
  (`apps/web/src/lib/workflow/delivery-epochs.ts`, `applyEpochOpsSql`): a
  version-guarded UPDATE of the epoch row, any successor INSERT and the
  projection of the writable branch onto `missions.workingBranch`, chained as
  CTEs. Unique indexes hold the shape: one epoch per (mission, number), one
  successor per predecessor, one open epoch per mission. A lost race re-reads
  and reduces again, so a replayed or concurrent merge is a `noop`.
- At most one epoch is writable (`open`). When an epoch merges (`Merged`, from
  GitHub's values), the kernel records it terminal and, if the mission has
  unshipped work (unfinished deliverable tasks or open task PRs), cuts exactly one
  successor from the merge commit, as one transition. A merged epoch is terminal
  and immutable (branch, PR, merge commit, merged head, timestamps, the scope
  version it carried); the mission is not. A successor gets a name no epoch used
  (`<branch>-delivery-<n>`, from epoch 1's name exactly, never stripped), so
  GitHub's delete-branch-on-merge of a merged branch can never take later work
  with it. A transition that moves `missions.workingBranch` applies only while
  the mission still names the branch it read; otherwise nothing is written and
  it is re-read.
- Work filed or a task PR opened after the newest epoch merged with nothing left
  (`EnsureWritable`): the kernel cuts one successor from trunk's head. A
  completed or archived mission is never given one.
- What a transition leaves owed is derived from the rows
  (`pendingEpochSteps`): cut the successor's branch, settle the merged branch,
  retire it, in that order. Each is performed against GitHub and recorded back
  through the reducer, by the merge's own door, the kernel's `finalize_mission_pr`
  effect, or the hourly reconcile, whichever comes first; a crash between a step
  and its record redoes the step.
  Each delivery's steps run independently, so a held delivery blocks only
  itself. The hourly reconcile adopts a mission with no delivery rows, so a
  merge whose record failed is retried: a mission PR merged in the last 48
  hours is adopted as the merge being recorded only when the branch is gone or
  still sits at the head that merged (`adoptionFacts`). A branch that moved on
  is the live delivery (an adopted re-cut), never settled or deleted as the
  merged one.
- No branch is deleted with work on it: the last read before a delete requires
  the branch to sit at the merged head or be contained in trunk. Otherwise the
  branch is kept (`settlement.unshippedHead`), one mission note asks a person,
  completion stays held, and the next pass retires it once trunk has the
  commits or a person removes them.
- The doors: every mission-PR merge door and the merge webhook record the merge
  through `kernel-client` (`mission_epoch`, action `merged`); the branch is no
  longer deleted at merge (`finalizeMissionPrMerge`). A task filed into the
  mission and `create_pr` ask for a writable epoch first. A task filed under an
  earlier epoch is claimed onto the writable branch (`isPriorEpochBranch` at the
  claim); a refresh keeps the branch it was filed for. That branch is recorded
  once at filing (`context.refreshBranch`) and a requeue never rewrites a
  refresh's `baseBranch` (`requeueBranchContext`). A refresh filed before
  either, whose `baseBranch` a requeue overwrote with its own head, is judged by
  where its PR is based: the writable delivery's branch, never trunk
  (`refreshFiledFor`).
- Compatibility: a mission that predates epochs is adopted on its first epoch
  command, from its recorded mission PR (`adoptionOf`): no PR, or an open one, is
  epoch 1 open; a merged PR with no work left is epoch 1 merged and retired; a
  merged PR with work left (the live re-cut under the same name) is epoch 1
  merged plus epoch 2 open on that same branch, which is never deleted while the
  open epoch uses it. Until adopted, a mission's readers keep the pre-epoch
  answers. History before adoption is not reconstructed.
- Scope amendments (S6b): a deliverable task added to a mission (not the
  organizer decomposing its own brief) gets one scope decision at the Decide
  point `mission_scope` (`in_scope | amend_scope | ask`, decision kind
  `buildd.mission_scope`), recorded with `decideAndRecord`, so a replay reads
  it and never asks again. The package's `planScope` turns it into what is
  written, in one statement (`apps/web/src/lib/workflow/scope-amendments.ts`,
  `workflow_scope_amendments`):
  - `in_scope`: the decision row only. No description churn, no prompt.
  - `amend_scope`: the row with the mission's description and goal criteria
    before and after, the reason and the source task; the mission's
    `scopeVersion` moves by one (compare-and-set on the version the plan read,
    so two amendments at once each get their own version), and the open
    delivery takes it when it has no PR yet. A delivery already in review keeps
    the version it was reviewed under, and the next one is cut with the new
    version. The amendment is the filer's proposal (`context.missionScope`) or,
    by default, one scope line naming the task appended to the description.
  - `ask`, or any amendment that would remove a criterion, change a command,
    turn a mechanical criterion into prose or clear the list
    (`criteriaWeakening`): held. The task gets the claim gate's single-task
    hold, and one mission note asks a person; the contract is unchanged.
  - The default (no decider, an error, a timeout, an invalid or low-confidence
    answer) is `in_scope`, or `amend_scope` when the filer proposed one, so
    ordinary filing never waits on a person, and the default is recorded with
    its reason. NOT IMPLEMENTED: recording the person's resolution of a held
    decision when the task is resumed (the hold is lifted by the normal Resume),
    and the decision for a task moved into a mission by `link_task`.
- Refresh reads "shipped" from delivery state: a refresh acts on the writable
  epoch's branch only, and never runs for a merged epoch
  (`mission-branch-refresh.md`, Eligibility). NOT IMPLEMENTED: the refresh as
  an outbox effect of the epoch; it still runs from the start trigger and the
  backstop, gated on epoch state.
- A clean refresh merge is a recorded fact on the delivery (head moved by
  refresh, not a fix, §13.13 rule 5).
- A conflicted refresh files one pinned builder (single-flight per epoch and
  trunk head). If it finds the branch already contains trunk it completes as
  a verified no-op with the ancestry as evidence, no PR required.
- Before an epoch's branch is deleted, the kernel settles every open PR still on
  it and every PR recorded as moved off it by a retarget (`movedPrs`, from the
  `pull_request.edited` webhook), one settlement per branch at a time (a
  lease), each content probe on a scratch ref of its own
  (`classifySettlement`, task a11abc4b): proven redundant (its head is in the
  merge commit, or a scratch test merge leaves the tree unchanged) is closed
  with the epoch PR recorded on its delivery; task work is retargeted to the
  successor; a refresh with work of its own, or anything unreadable, holds the
  branch and asks a person once. The branch retires only when nothing is held
  and a fresh read shows nothing open on it.
- When a delivery branch is finished (`deliveryBranchFinished`, task fbc93ebd):
  the mission is completed or archived; the delivery merged (and no later
  delivery reuses its branch) or its branch retired; or its PR closed unmerged
  and was superseded with no successor, meaning the closed PR's work is
  recorded as landed in another merged PR, or a content check shows the branch
  already in trunk, and no other PR from the branch into trunk is open.
  Closing the integration PR alone does not finish the branch: it is still the
  mission's, a new PR can open from it, and a refresh onto it stays valid.
- On a finished open delivery, every reconcile settles the refresh PRs still
  based on its branch (`settleFinishedBranch`): each is closed with a comment
  saying why the branch is finished, and recorded as superseded by the merged
  PR that carries the branch's work when one is known; a refresh filed for the
  branch that never started is cancelled. With no such PR (the branch is in
  trunk, but no row says through which PR) one mission note asks a person
  where to record the closed PRs. Task PRs on the branch are never touched.
  A closed refresh whose record or note failed is found again from the rows
  (closed, unmerged, no resolution, based on the branch) and settled on the
  next pass; the note is posted once per delivery. The settlement reads only
  as far as it needs: an open or merged delivery PR stops at one read, and the
  content check runs only when a refresh is left to settle. The mission-PR
  line names where a closed PR's work landed when an edge records it, and
  never claims the branch finished: the rows it reads cannot rule out an open
  successor, which only the live settlement checks.
- Projection (S6c): the mission page and `manage_missions get` read the
  delivery records. The mission-PR line is the current delivery ("Delivery 2"),
  with shipped deliveries named beside it ("Delivery 1 merged (#n)"), never a
  merged mission PR standing for the mission (`deriveMissionIntegrationPr` with
  `deliveries`). Recorded scope amendments and holds show as one line each, in
  words. The mission's own state still comes from its tasks and criteria.
- Mission completion reads delivery and epoch state, never `workers.mergedAt`:
  it is held while a shipped delivery's branch still has PRs to settle, or the
  writable epoch carries landed work that has not reached trunk
  (`epochCompletionHold`), then the mission's criteria decide. No merge door
  lands a task PR on a shipped delivery's branch (`delivery_shipped`).

**Acceptance criteria**:
- AC-20: GIVEN a mission whose epoch 1 merges while tasks remain WHEN the merge
  is ingested twice THEN exactly one epoch 2 branch and PR exist and the
  remaining task PRs target it (the #3787 sequence).
- AC-21: GIVEN a merged epoch WHEN a task in the mission is claimed or the
  refresh backstop fires THEN no refresh of that epoch is attempted and no
  refresh task is filed (the ecea17f3 sequence).
- AC-22: GIVEN a refresh builder whose branch already contains trunk WHEN it
  completes THEN completion succeeds with the ancestry evidence and no PR.
- AC-71: GIVEN a refresh whose task was requeued after an infra failure WHEN
  any door asks whether its PR may land THEN the branch it was filed for is
  the mission branch, never its own head, and a refresh retargeted to trunk is
  still refused.
  replaces: AC-32
- AC-23 (failure): GIVEN an open refresh PR with unique commits WHEN its epoch
  merges THEN the branch is not deleted until that PR is retargeted or
  escalated, and nothing retargets it to trunk silently (the #4670 sequence).
- AC-73: GIVEN an open delivery whose integration PR closed unmerged, with an
  open refresh PR on its branch WHEN the delivery is reconciled THEN the
  refresh PR stays open while the closed PR's work is neither recorded as
  landed elsewhere nor in trunk, and is closed with a comment (and recorded as
  superseded by that merged PR, when there is one) once it is; a successor PR
  from the branch keeps it open (the #4909/#4913 sequence).
  replaces: AC-34

| AC | Test |
| --- | --- |
| Criterion AC-20 | `packages/workflow-kernel/src/delivery-epochs.test.ts` › "AC-20 / scenario 1 and 3"; `apps/web/tests/db/mission-epochs.test.ts` › "AC-20", "scenario 2" |
| Criterion AC-21 | `apps/web/src/lib/mission-branch-refresh.test.ts` › "mission delivery records (AC-21)" |
| Criterion AC-22 | `apps/web/src/app/api/workers/[id]/route.test.ts` › "mission-branch refresh already on the branch" |
| Criterion AC-23 | `apps/web/tests/db/mission-epochs.test.ts` › "AC-23 / a11abc4b"; `apps/web/src/lib/mission-pr.test.ts` › "a refresh PR lands only on the delivery it was filed for" |
| Criterion AC-71 | `apps/web/src/lib/integration-refresh.test.ts` › "refreshFiledFor"; `apps/web/src/lib/stale-workers.test.ts` › "#4909"; `apps/web/src/lib/mission-pr.test.ts` › "#4909" |
| Criterion AC-73 | `packages/workflow-kernel/src/delivery-epochs.test.ts` › "deliveryBranchFinished"; `apps/web/src/lib/workflow/delivery-epochs.test.ts` › "settleFinishedBranch"; `apps/web/src/lib/mission-integration-pr.test.ts` › "a closed mission PR whose work landed elsewhere" |
| Scope decisions (task f3bda4e1 scenarios 5–7) | `packages/workflow-kernel/src/scope-amendments.test.ts`; `apps/web/tests/db/scope-amendments.test.ts` |
| Mission page and API distinguish the mission from its deliveries (scenario 8) | `apps/web/src/lib/mission-integration-pr.test.ts` › "with delivery records"; `apps/web/src/lib/mission-scope-view.test.ts` |
| Completion reads epochs (task f3bda4e1 scenarios 1, 4) | `apps/web/src/lib/mission-completion.test.ts` › "scenario 1", "scenario 4" |

## 7. Projections

**Capability statement**: Every surface that shows where work stands MUST
derive it from the delivery, so the task page, mission page, Home, `get_pr`,
`explain` and the GitHub activity comment never disagree.

**Invariants**:
- One reader (`getDeliveryViewsForTasks` and the package's projections) feeds
  every surface; no surface computes lifecycle from the latest worker row or
  legacy reviewer rows.
- `get_pr` reports reviews from review rounds; it never says "Reviews: none"
  while rounds exist (§13.13 rule 8).
- A repair shows queued, running, awaiting push, pushed and testing, awaiting
  review, or no change, from attempt facts.
- CI is read per head (task 6900a317). The delivery keeps one CI reading,
  bound to the head it was read on (`ci`, `ciHeadSha`); a reading on another
  head says nothing, so a new commit reads running until its own CI reports,
  and a late or out-of-order webhook for an older head records nothing. A
  failed check outranks checks still running. A run that a newer run of the
  same check name replaced on the same commit (a re-run, or a gate re-triggered
  by a PR-body edit) no longer counts, in the kernel's reads (`checkRuns`,
  `ciGreen`) and in the per-commit history alike, the way GitHub's merge box
  and the landing door (`latestRunPerName`) already read it. The reading is
  recorded whether or not anything acts on it (`CiObserved`, no state change):
  T10 deferring to an open CI fix, a state CI does not move, or a green with no
  repair to end still leaves the head red, running or green. A green reading on
  the current head of a delivery held `ESCALATED(ci_exhausted)` ends that hold
  (295486ba): a spent CI budget is a person's only while CI is red, so it goes
  back to review or landing the way a CI repair that ends green does. A spent
  review budget under it stays the person's and the escalation names it
  (`review_exhausted`).

**Acceptance criteria**:
- AC-24: GIVEN a delivery with two review rounds WHEN `get_pr`, the task page
  and the activity comment render THEN all three show the same round count,
  latest verdict and finding totals.
- AC-25: GIVEN a mission whose epoch merged and has no other open work WHEN
  `explain` reads it THEN it is not "stalled".
- AC-26 (failure): GIVEN a worker row that says merged and a delivery that says
  in review WHEN any surface renders THEN it shows the delivery's state and
  flags the disagreement in `explain`.
- AC-72 (failure): GIVEN a CI fix that pushed a new head and is still open
  WHEN one check fails on that head while others run THEN the PR reads CI
  failed, not running; WHEN that check is re-run THEN it reads running, and
  WHEN everything passes THEN it reads passed with no state change; a green
  for the older head changes nothing, and the next commit reads running.
  replaces: AC-33
- AC-67 (implements Living Spec criterion AC-45): GIVEN a review escalation
  WHEN a person asks for a forced re-review or one more bounded fix from the
  decision surface THEN it is one kernel command (`ReviewRequested` forced, or
  `HumanResolve(apply_recommendation)`) bound to the head and version the
  person saw, applied through the control-plane door, recorded with the person
  and the head on its transition; the same decision submitted again is
  answered by the first (`duplicate`) and dispatches nothing; the escalation
  note clears only after the command applied, and a replay that reaches a PR
  escalated again since clears nothing.
- AC-68 (failure; implements Living Spec criterion AC-46): GIVEN a review
  escalation WHEN a decision names a head that is no longer current, is made
  by an agent, or approves past findings without merge permission THEN it is
  refused (`decision_head_stale`, `human_required`, `no_merge_permission`),
  nothing moves or is dispatched, the note stays, and the door answers with a
  plain sentence that names what was wrong and what to do, never a bare code.
- AC-81 (implements Living Spec criteria AC-45/AC-46, follow-up 22): GIVEN a
  review escalation with required findings still open or awaiting
  verification WHEN a person whom the merge policy allows, with an owner or
  admin team role and merge permission on the repo on GitHub, chooses
  "Approve and override" THEN it is one `HumanResolve(approve)` bound to the
  head (and version) they saw, through the person-only `approve_override` op;
  the delivery is `APPROVED` on the basis `human` for that head, the bypass
  names the person, their reason and the findings it went past, the findings
  stay listed, `Buildd / Review approval` turns `success` for that head, the
  escalation note clears, and the landing merges it once; the same decision
  again is answered by the first and changes nothing.
- AC-82 (failure): GIVEN the same escalation WHEN the head moved since, an
  agent, an API key or a task token asks, the person lacks merge permission,
  or the merge policy or their role does not allow an override THEN it is
  refused (`decision_head_stale`, `human_required`, `no_merge_permission`,
  `override_not_permitted`, or the door's own `policy_off` / `role`), in a
  plain sentence, and nothing moves.
- AC-69 (implements Living Spec criterion AC-47): GIVEN findings in every
  disposition WHEN `get_pr`, the task page, the activity comment and the
  DeliveryView count them THEN each required finding is counted once, in one
  of open, addressed awaiting verification, verified resolved, waived or
  deferred, and the totals add up.

Decisions (Living Spec r7 §7, task 59f2c591). A person's decision on an
escalation carries `decision: { id, headSha }`. The id is the action, the head
and the delivery version the decision card showed (`humanDecision`, e.g.
`force_re_review:<head>:v<version>`); the transition's idempotency key is
derived from it (`humanDecisionKey`), so a double tap, a retried request or a
door re-sent after an unknown outcome finds the first transition. A decision
is checked before anything else the command reads: only a `human:` actor may
make one, and its head must be the delivery's current head. The doors are the
existing `request_review` and `apply_recommendation` operations, so the single
host rule holds unchanged. The re-review and apply-recommendation routes read
`headSha` and `version` from the card (the forced review also as its
`expectedVersion`), clear the escalation note on `applied`, or on `duplicate`
only while the PR is no longer `ESCALATED`: a stale tab replaying a decision
after the PR escalated again ran nothing, so it is refused as
`decision_already_answered` and the new note stays. Refusals are answered with
`explainDecisionRefusal`, on these doors and on `request_pr_review`.
`DeliveryView` carries `findingTotals`, and the escalation brief carries the
same groups (`open`, `addressedAwaitingVerification`, `resolved`, `waived`,
`deferred`), their `totals`, and `decisionHead { headSha, version }` for the
card to send back. Whether the brief offers approve-and-override is whatever
the surface passes as `escalationPermissions` per workspace
(`getDeliveryViewsForTasks`, asked only for a delivery escalated for a review
reason); absent, the override is not offered.

Approve and override (follow-up 22, task 90898aca). Who may take it comes from
three readings, none a list in code (`apps/web/src/lib/override-permission.ts`):
the workspace merge policy's `reviewOverride` (`admins`, the default, or
`off`), the person's team role in the team that owns the workspace (owner or
admin), and their GitHub permission on the workspace repo through its
installation (write, maintain or admin; `users.githubId` resolved to a login,
as `member-repo-access.ts` does). Anything unconfirmed is no. The task page
passes the viewer's answer to the brief (`loadTaskDeliveryContext(taskId,
viewerId)`), with the refusal as a sentence, so the card offers the action
only to someone who can take it. The door is `POST
/api/prs/[prNumber]/approve-override` (`{ headSha, version?, reason?,
workspaceId? }`), from a dashboard session or the person's own OAuth session
(MCP `approve_pr_override`); a key, a task token or an agent grant is refused
before anything is read. It re-reads the permission at the click, then
submits `approve_override` (`approveOverrideThroughKernel`): the live head is
recorded first, then `HumanResolve(approve)` with `decision
approve_override:<head>:v<version>`, `commitId`, `hasMergePermission` and
`overridePermitted`. The kernel refuses an approval past required findings
that are open or addressed without `overridePermitted` (`override_not_permitted`)
and records `overriddenFindings` on the bypass. On `applied` (or a replay
while the PR no longer waits on a person) the escalation note clears; a
replay on a PR escalated again is `decision_already_answered`.

How (S7, task c16eb202). The review line ("2 rounds · latest: changes
requested · 1 open finding, 1 verified resolved") and a repair's phase are pure readings in the
package (`reviewSummaryOf`, `repairPhaseOf`); `get_pr`, the task page's checks
list and PR card, and the activity comment all print the first, and `get_pr`
and the checks list the second. Surfaces that derive merged, open or closed
from worker rows (mission progress, unmerged PRs, mission health, the mission
PR line, Home's mission cards and upstream merge cards) read those rows with
the delivery's lifecycle laid over them on read (`overlayDeliveryLifecycle`),
so they need no rewrite and write nothing; a task with no delivery keeps its
rows. `list_prs` keeps a PR whose delivery is live, or merged in the window,
as a candidate whatever its worker row says.

| AC | Test |
| --- | --- |
| Criterion AC-24 | `apps/web/src/lib/projections-agree.test.tsx`; `apps/web/src/app/api/github/pr/route.test.ts` › "review rounds and standing from the delivery" |
| Criterion AC-25 | `apps/web/src/lib/explain.delivery.test.ts` › "AC-25" |
| Criterion AC-26 | `apps/web/src/lib/explain.delivery.test.ts` › "AC-26"; `apps/web/src/lib/delivery-overlay.test.ts`; `apps/web/src/lib/pr-list.test.ts` › "a kernel delivery still live" |
| Repair phases | `packages/workflow-kernel/src/delivery-summary.test.ts`; `apps/web/src/lib/task-checks.test.ts` › "repair phase (§7)" |
| Criterion AC-67 | `packages/workflow-kernel/src/conformance/scenarios.ts` › "r7 AC-45"; `apps/web/tests/db/escalation-decisions.test.ts` › "AC-45 / AC-46"; `apps/web/src/app/api/prs/[prNumber]/re-review/route.test.ts` › "Living Spec r7"; `apps/web/src/app/api/prs/[prNumber]/apply-recommendation/route.test.ts` › "Living Spec r7" |
| Criterion AC-68 | `packages/workflow-kernel/src/conformance/scenarios.ts` › "r7 AC-46"; `packages/workflow-kernel/src/decision-refusal.test.ts`; `apps/web/src/app/api/prs/[prNumber]/re-review/route.test.ts` › "AC-46" |
| Criterion AC-81 | `packages/workflow-kernel/src/conformance/scenarios.ts` › "approve and override: a person with merge permission"; `apps/web/tests/db/escalation-decisions.test.ts` › "approve and override"; `apps/web/src/app/api/prs/[prNumber]/approve-override/route.test.ts`; `packages/workflow-kernel/src/reducer.test.ts` › "over open findings needs overridePermitted"; `apps/web/src/lib/workflow/delivery-view.test.ts` › "read only for a review escalation" |
| Criterion AC-82 | `packages/workflow-kernel/src/conformance/scenarios.ts` › "approve and override is refused"; `apps/web/src/lib/override-permission.test.ts`; `apps/web/src/app/api/prs/[prNumber]/approve-override/route.test.ts` › "refused"; `packages/workflow-kernel/src/escalation-brief.test.ts` › "host's sentence" |
| Criterion AC-69 | `packages/workflow-kernel/src/findings.test.ts` › "findingTotals"; `packages/workflow-kernel/src/escalation-brief.test.ts` › "AC-47"; `packages/workflow-kernel/src/delivery-summary.test.ts` › "AC-47"; `apps/web/src/lib/projections-agree.test.tsx`; `apps/web/src/lib/workflow/delivery-view.test.ts` › "follow-up 22" |
| Criterion AC-72 | `packages/workflow-kernel/src/conformance/scenarios.ts` › "6900a317"; `packages/workflow-kernel/src/reducer.test.ts` › "CiObserved"; `apps/web/src/lib/workflow/github-facts.test.ts` › "a re-run supersedes"; `apps/web/tests/db/workflow-seam.test.ts` › "6900a317"; `apps/web/src/app/app/(protected)/tasks/[id]/PrDetailsCard.test.tsx` › "re-run replaced" |

## 8. Order of work

Each slice is one or more reviewed PRs to trunk, built locally (mission
2e3550ab), and ends with its ACs green.

| Slice | Delivers | ACs | Existing tasks folded in |
|---|---|---|---|
| S0 | this spec, with #4693's amendments to `workflow-state-kernel.md` and `mission-task-lifecycle.md` | — | ed50e3b2, #4693 |
| S1 | package with the pure modules, boundary test, in-memory store, conformance suite on the pure core; apps/web imports from it | AC-5, AC-6, AC-8 | — |
| S2 | ports for store, GitHub, clock, work, notify, policy, decide; effect handlers move into the package; Postgres adapter runs the suite | AC-7, AC-27–AC-29 | — |
| S3 | single host: command endpoint, drain and floor on the control plane, Vercel doors submit commands; every merge door through the gate on review verdict, head and CI; release doors pinned; `buildd/landing` status | AC-9–AC-12, AC-14–AC-16, AC-30 | cc59da33, 30a47173 |
| S4 | one writer: lifecycle columns written only by kernel transitions; write-site guard; render write-through retired | AC-1–AC-4 | 459b58ed (projections half) |
| S5 | findings model and pinned repair builders; the gate and status read open findings | AC-13, AC-17–AC-19 | 7d68f57d, 459b58ed |
| S6 | mission deliveries, epochs, refresh as an effect, settlement | AC-20–AC-23 | f3bda4e1, a11abc4b |
| S7 | projections agree | AC-24–AC-26 | — |
| S8 | remediation and verification: the #4686 strings, audit of recent integration PRs, independent replay of every incident sequence on the merged code, rollout record | all | 5ad8da67, 6a09cd3c, 3f36b5ac |

S5 and S6 can start after S2; S3 and S4 after S2. S7 follows S4.

## 9. Writer inventory (debt to zero)

Measured on dev at the start of this spec. Every entry is a writer of a §1
column outside the kernel; S3 and S4 remove or route each one.

- `workers.mergedAt` / `prLifecycleStatus`: `recordPrFact` (single writer,
  own terminal-wins rule) called from the webhook, `register-local-pr`, the
  dashboard merge route, `PUT /api/github/pr`, `mission-pr.ts`,
  `pr-state-refresh.ts` (render read-through), `pr-reconcile.ts`,
  `dead-zone-sweep.ts`, the admin backfill, `pr-review-request.ts`,
  `dead-pr-shutdown.ts`. Becomes a fact funnel only. S4a: T17 / T18 write
  both columns on every worker row of the delivery's PR in the transition's
  own statement; a terminal fact (merged, closed) from any of these callers
  carries the kernel's scope (`pr-fact-scope.ts`), so a delivery-owned row
  takes only what its delivery already says. Their non-terminal facts
  (`pr_open`, CI, conflict, unresolvable) carry the same scope, which defers
  every delivery-owned row: the funnel reports it (`deferred`, so a caller's
  side effects still see a fact that is new for the row) and writes none.
  Every other kernel transition projects the row's live status from the
  delivery's own readings at its head, in its own statement (`w_live`,
  `prLiveProjectionSql`): dirty mergeability is `conflict`, then a red or
  green CI verdict, else `pr_open`. A funnel call with no scope is refused,
  by type and at run time, and the write-site guard names its file. "Delivery-owned" has
  one definition (`kernelOwnedRowSql`: a kernel-authority delivery, kill switch
  on, owns the row's PR), shared by the funnel and the render read-through. A
  merge the kernel saw but could not apply (its live read failed, a render
  recorded it) is queued for a fast heal on the per-minute dispatch tick
  (`kernel-heal.ts`), and the floor reads unapplied terminal facts first and
  rotates by `floor_checked_at`. A merge after ABANDONED or SUPERSEDED has no
  edge: it is recorded on the fact as a contradiction, notified, and shown on
  the delivery's view.
- `workers.prUrl` / `prNumber`: `create_pr` route, `mission-pr.ts`, worker
  PATCH, `register-local-pr`.
- `workers.status`: worker PATCH, claim, reassign, cleanup, interrupt,
  recover, respond, lost-claim, `stale-workers.ts` sweeps,
  `interactive-detach.ts`, `terminal-answer.ts`, `supersession-store.ts`.
  Kept for tasks with no delivery; for a delivery-owned task an attempt fact.
- `tasks.status` / `tasks.result`: worker PATCH (completion and reviewer
  verdict), claim, webhook (issue events, branch-match auto-complete on merge,
  release tasks), `runMergedPrWork`, `ci-failure-retry.ts`,
  `loop-webhook.ts`, `task-dependencies.ts`, `update_task`, bulk, cleanup,
  reassign, `correct_task_result`, interrupt, webhook ingest, Linear webhook,
  quality-scout, credential recovery, repo access, `stale-workers.ts`,
  supersession, visual review decisions, surface audit, recovery hold,
  evidence and shipped stores. S4b: a merge of a kernel-owned PR completes
  the owner task in the T17 statement itself (`task-projection.ts`, beside
  `w_proj`), with the rule `runMergedPrWork` applied (already completed stays,
  a local session or another open PR on the task keeps it open), and tells
  the `emit_pr_merged` effect what it did; `runMergedPrWork` writes no task.
  "Delivery-owned" for a task has one definition (`deliveryOwnedTaskSql`).
  Writers that infer where a PR went (the branch-name merge match, the
  stale-failure archive, the dependency-failure cascade) skip a
  delivery-owned task in their own WHERE. The rest stay, each listed in the
  guard with its reason: the end or requeue of a worker's own attempt (for an
  owner task `tasks.status` is the attempt's lifecycle, which the kernel
  reads, so these cannot move without stranding it), a person's act, a task
  that provably has no delivery, or a `result` key that is not a delivery
  field. Every attempt writer that can move a task away from completed carries
  `notKernelMergedTaskSql` in its WHERE, so a completed task whose delivery
  MERGED is never failed, requeued or reactivated by a late worker report, a
  stale release check or the reaper (a requeue would build it twice); the
  guard pins how many statements per file carry it (a person's follow-up that
  reactivates the worker of a shipped task leaves the task completed). Only
  the merge's work-tracker comment runs behind a context once-marker; the
  `task.completed` fan-out (deduped by its key) and `resolveCompletedTask`
  (each step guarded on its rows) re-run on every retry of `emit_pr_merged`,
  so a function killed mid-way loses nothing. Legacy merge writers skip a task
  only for the PR its delivery is bound to: another PR of the same task (a
  stacked series, a follow-up after the delivery's PR was abandoned) still
  completes it.
  The attempt writers are listed statement by statement (`ATTEMPT_SITES` in
  the guard): each `tasks.status` / `tasks.result` statement of an ATTEMPT
  file is named by what it writes and classed as routed through a named kernel
  command, never reaching a kernel owner (in its own WHERE, or by a named code
  path), result or context only, or debt (it still sets a kernel owner's
  status itself). A routed statement is checked on its own: every `status`
  it sets must sit behind its own owner check (inside the spread an owner
  skips, as a value that keeps an owner's status in SQL, or on a branch only
  a non-owner reaches), so putting a direct status write back fails CI even
  while the file still calls the command. A new attempt writer, or a new
  statement in one, fails CI until it is classed, and the number of debt
  statements (`ATTEMPT_SITE_CEILING`) only goes down.
  The kernel reads an owner attempt's end from its latest worker row, not
  from `tasks.status` (`ownerAttemptEndOf`, used by `forwardOwnerEnd` and the
  floor): a finished worker is an end even while the task is still
  `assigned` (the status a running owner task holds for its whole attempt),
  so an end that never arrived is re-sent. `pending` (its retry is queued)
  and `cancelled` (the cancel sent its own end) are never an end. On an
  `assigned` task the end counts only for a worker row created at or after
  `claimed_at` (the claim stamps it, then inserts the new worker row, so an
  older row is the previous attempt's while a claim is in flight), and only
  once that row has gone unchanged for `OWNER_END_SETTLE_MS`: the worker
  PATCH writes the worker's terminal status before it decides on a retry
  requeue, so an end read in between is not sent. A terminal task's end
  counts at once.
  The owner attempt's end projects onto its task: T4 for an owner (an end
  of the attempt a `WORKING` delivery is bound to) sets the owner task in
  its own statement (`t_attempt`, task-projection.ts), reading the delivery
  CTE, so a version miss writes nothing. `success` completes it; `failed`,
  `lost` and `unproven` fail it. The kernel's own requeue (a
  `taskRetryBudgetLeft` end it answers by keeping the delivery `WORKING`)
  projects nothing; a `taskRetryBudgetLeft` end that moves the delivery on (an
  unproven end with commits goes to `AWAITING_PUSH`) projects like any other,
  which leaves the task alone because its retry already set it `pending`. It
  moves only an open task (`assigned`, legacy `in_progress`), so a cancel, a
  requeue to `pending`, or a status another writer already settled is kept,
  and only for the task's current attempt: the ending worker must be the
  task's latest attempt row (placeholder rows no runner executed, such as the
  sibling row a second PR gets, do not count) and not older than its
  `claimed_at`, which the claim stamps from the database clock, so an end
  that lands late (a parked re-send, a slow door) after the task was requeued
  and claimed again never settles the new attempt. It carries
  `notKernelMergedTaskSql`. An owner end that applies nothing (a duplicate, a
  stale end) still projects (`projectOwnerEnd`): the ledger's recorded
  `end:<workerId>` wins, else the end that was sent. The floor's re-sent end
  therefore settles a task that stranded `assigned`, and for a delivery
  already past `WORKING` (an end applied by an older control plane that did
  not project) the floor projects the settled latest attempt's end itself,
  never while an attempt on the task is still live.
  The worker PATCH is the first family behind it: for the plain end of a
  kernel owner attempt (no retry or loop hold, no contract or loop failure)
  its completion statement writes result, loop and context but not status.
  It sends the end before anything in the same request reads the status
  (the mission release, the terminal evidence record, dependency resolution,
  mission completion), then runs `projectOwnerEnd` itself, so a control plane
  that is down or too old to project, a delivery the kill switch released, or
  a release held for CI (no end is sent) still leaves the task settled. A
  release that fails still writes `failed` itself.
  A task's PR is derived on read, never snapshotted (`task-pr.ts`): its own
  delivery's PR when it owns one, else its newest attempt worker row that
  carries a PR, else a placeholder row (an adopted PR, a person's attach),
  else what `result` stored before this. The sibling row a second PR from one
  worker gets is a placeholder, so it never displaces the attempt's own PR.
  No attempt writer puts `prUrl` / `prNumber` into `result` (the worker
  PATCH's completion, the cleanup promotion, the reaper's promotion); the
  guard fails on one that does. So an end that lands late on a task that was
  requeued and claimed again cannot put the old attempt's PR back, and a loop
  exit that replaces `result` no longer erases the PR. Every reader goes
  through it: `get_task` and the task page, the mission sheet, the terminal
  audit list, mission and heartbeat context, the completion callback, the
  evidence record and the attach guard. No write statement dropped with it:
  each still writes `status` or other `result` keys, so the attempt ceiling
  is unchanged until the reaper, requeue and claim families move.
  The reaper is the second family behind it (`stale-workers.ts`). When it
  gives up on a kernel owner attempt (the silent-start, retry and infra caps,
  now one statement) it writes the task's `result` but not its status and
  submits AttemptEnded(lost) through the kernel client, then runs
  `projectOwnerEnd` itself, so the task settles even when no control plane
  projected it. The unanswered-question sweep does the same and writes
  nothing to the task, except a question superseded by recovery, which is no
  attempt end and still fails the task itself. Both act only when the
  reaped worker is the open task's current attempt
  (`reapedOwnerAttemptIsCurrent`: an attempt row, not a placeholder that no
  runner executed, such as an `external`, `system` or `openclaw` row, and
  current by the `endingWorkerIsCurrentSql` rule). The fail write repeats
  that check in its own WHERE, and the end is sent only if the write matched.
  A late reap, after the task was requeued and claimed again, therefore does
  nothing: no status, no result, no end in the ledger, and no requeue of the
  new attempt's task. An infra requeue to `pending` is still no attempt end
  and still the reaper's own write. The reaper's attempt ceiling drops from
  11 statements to 9.
  A requeue goes back to the queue through the kernel too: `AttemptRequeued`
  names the requeuing worker and its attempt (an owner by task id, a repair by
  its ledger row) and is no end, so the delivery keeps its state. While the
  delivery is bound to that attempt (`WORKING` on the owner task, or
  `FIXING` / `REPAIRING` on that open ledger row) the transition records it
  under `requeue:<workerId>`, so a re-send is a duplicate, and moves the task
  to `pending` with its claim released in its own statement (`t_requeue`,
  task-projection.ts), reading the delivery CTE. A requeue the reducer does not
  bind (the delivery moved on while the task kept running, as a loop task's
  next iteration does, or a terminal delivery) records nothing. A kernel
  owner's requeue only ever moves an `assigned` or `in_progress` task: a task
  already `pending`, a cancel and any settled status are kept. Every requeue,
  bound or not, projects under the same guard (`projectRequeue`): only an open
  task, only while the requeuing worker is its current attempt, never over a
  kernel-merged completion, and for a repair only while its ledger row is
  open. So a requeue that lands late, after the task was claimed again, moves
  nothing. It is a door op (`attempt_requeued`), applied only where the kernel
  is hosted, parked when the control plane does not answer, and applied on the
  web host during release skew. The worker PATCH's requeues are behind it for
  a kernel owner: a retry and a loop hold (the completion statement writes
  their context, start floor and loop fields under the requeue's guard, but
  not status or claim), and the budget, codex-deferral, mount-gap and
  auth-failover requeues, which share one helper (`requeueWorkerTask`). The
  conflict-fix recovery requeues a stalled kernel repair the same way. Each
  caller also projects the requeue on its own host, so a control plane that is
  down or too old still leaves the task pending. A task with no delivery keeps
  its own requeue write. The worker PATCH's ceiling drops by the three requeue
  statements the helper replaced.
  A claim starts the owner attempt through the kernel (`AttemptStarted`). The
  claim route still decides the race in one compare-and-set, never a
  transaction: for the owner task of a kernel delivery it matches only a
  `pending` task that no other claim holds (`ownerClaimOpenSql`, the claim
  query's own rule: unclaimed, or a claim past its expiry), and writes the
  claim (`claimed_by`, `claimed_at` from the database clock, `expires_at`,
  context, model) but not the status. Exactly one claimer gets a row back;
  every other one loses as before and never reaches the kernel. The winner
  then sends `AttemptStarted` naming its claim (task, account, and
  `claimed_at` as Postgres renders it, microseconds kept). It is no end and
  moves no state: while the delivery is `WORKING` on that owner task the
  transition records it under `start:<taskId>:<claimedAt>` (a re-send is a
  duplicate, the next claim a new key) and moves the task to `assigned` in its
  own statement (`t_start`, task-projection.ts), reading the delivery CTE. Any
  other state (a loop task's next iteration, after the hand-off) or a terminal
  delivery records nothing. Bound or not, the start projects under one guard
  (`projectAttemptStart`): only a `pending` task still carrying exactly that
  claim, never a kernel-merged one. So the kernel cannot assign a task to a
  claimer that lost the race, and a start that lands late (after a cancel, a
  requeue and a new claim, or an expired claim taken over) moves nothing. It
  is a door op (`attempt_started`) with its own small budget
  (`ATTEMPT_START_BUDGET_MS`, 750 ms; `KERNEL_START_BUDGET_MS` overrides),
  apart from the fix claims' budget (a retry's sleep is cut to what is left of
  it, so a hang cannot overrun it). The door itself never parks it, and it is
  never run on the web host in own mode, not even during release skew: an older control plane's
  refusal is one more door error. A start the control plane leaves unanswered
  opens a process-level breaker (`ATTEMPT_START_SKIP_MS`, 45 s): until it
  closes, starts skip the door. An interactive session's claim never asks the
  door at all. On any door error, a skipped door or an interactive claim, the
  route projects the start itself, so a control plane that is down, slow,
  refusing or too old never fails a claim: a runner's claim waits at most the
  start budget once per breaker window, and a person's own session not at all
  (`tests/db/claim-attempt-start.test.ts` measures a 503, a hang and refused
  connections at the default budgets). A start projected without a kernel
  answer would leave no `AttemptStarted` in the log, so the route parks it once
  in `workflow_command_outbox`, after the response and never on the claim's
  critical path (`parkAttemptStart`), under one command key per claim
  (`attemptStartKey`; the door submission of a runner's claim uses the same
  key). The floor replays it on the control plane: the kernel records the
  transition once (the `start:<taskId>:<claimedAt>` key makes a repeat a
  duplicate), and the guarded projection moves nothing, because the task is
  already assigned. A replay after the task moved on (requeued, claimed again)
  is judged by the reducer and the guard and changes no task. A start the
  kernel answered is not parked. A claim lost after its compare-and-set
  gives back only its own claim fields, with no status write. A request that
  dies between its compare-and-set and the start leaves the task `pending`
  with the claim set, and no one can claim it until the claim's `expires_at`
  passes (the task's `timeoutMinutes`, 15 minutes by default), the same way a
  legacy claim that died before inserting its worker recovers. The start's
  effects are drained by the floor, never inline on the claim. On the web host (shadow) the start adds a few
  statements (the delivery read, the view, the transition, the projection
  read): single-digit milliseconds against a local Postgres in
  `tests/db/claim-attempt-start.test.ts`; in own mode it is one control-plane
  request. A task with no delivery, a repair and a review keep the claim's own
  status write; the two rollbacks of the route's own assigned claim (a fix the
  kernel deferred, a worker the account cap refused) are one helper
  (`rollBackClaim`), so the claim route's ceiling drops from four statements
  to three.
  The last attempt families go through the kernel the same way (AC-1 slice
  8), each tested against a real Postgres late (after the task was claimed
  again) and twice (`tests/db/attempt-writers-kernel.test.ts`):
  - CI retries exhausted. The transition that escalates the delivery
    (`escalate_exhaustion`, family `ci`) fails the owner task in its own
    statement (`t_escalate`, task-projection.ts), reading the delivery CTE; an
    owner end that escalates in the same transition is projected `failed` by
    `t_attempt` instead, one write per row. `escalateCiRedHead`, which the
    Escalate effect calls, keeps a delivery-owned task's status in SQL
    (`deliveryOwnedTaskSql` for that PR) and writes only the summary and the
    once-per-head marker. A delivery the kill switch released is legacy and
    is failed by that write as before.
  - Loop exits. On a merge T17 is the writer: the loop records only its own
    fields (`loopState`, iteration, history). T17 leaves a task a local session
    ran to that session, but a loop task's session attempt has already ended
    (the loop parked the task), so the loop exit completes it under the
    projection below; a session still live on the task keeps it. On green
    checks the loop re-sends
    the held attempt's end (`AttemptEnded` for the task's latest attempt, a
    duplicate when the hold already sent it), then completes the parked task
    under one guard (`projectLoopExit`): only the delivery's owner task, still
    `pending` with the loop satisfied by the exit's own compare-and-set, no
    live attempt on it, no other PR of the task still open, never over a
    kernel-merged completion. A claim of the
    next iteration keeps its task.
  - The worker PATCH's silent-completion retry is a requeue (`AttemptRequeued`)
    and its spent retry the attempt's failed end (`AttemptEnded`, then
    `projectOwnerEnd` on the route's host); its statement writes context and
    result only, and only while the reporting worker is the open task's
    current attempt. A credential hold is a requeue too: it writes the probe
    floor and the hold under the same guard. The budget and auth-failover
    requeues (slice 6) are covered against a real Postgres here, late reports
    included.
  - The reaper's infra requeue, its release of an interactive lease or an
    undelivered claim, and "Release slot" are requeues (`AttemptRequeued`,
    with `projectRequeue` behind them), written only while the released worker
    is the current attempt. Its expired loop waits and reviewer rounds never
    reach a kernel owner: their writes carry `notDeliveryOwnedTaskSql`, and
    a kernel owner's loop wait ends with its delivery. A reviewer round's own
    task is no delivery owner; for a kernel round the reaper's failure reaches
    the kernel as `ReviewRoundFailed`.
  - A stalled conflict fix with no worker row stays the recovery's own write:
    it is a repair task, never the delivery's owner, and with no worker row
    no attempt exists to requeue (`AttemptRequeued` names a worker). One with
    a worker row is requeued through the kernel (slice 6).
  The last twelve attempt statements go through the kernel too (AC-1 slice
  9), each tested against a real Postgres late (after the task was claimed
  again) and twice (`tests/db/attempt-writers-slice9.test.ts`). Two commands
  cover what no earlier one fits; like `AttemptStarted`, neither is an end
  and neither moves the delivery's state: while the delivery is `WORKING` on
  that owner task the transition records it and moves the task in its own
  statement (`t_reopen`, `t_withdraw`, task-projection.ts); otherwise it
  records nothing, and the caller projects the same move under the same guard
  (`projectReopen`, `projectWithdraw`). Both are doors on the start's small
  budget and breaker (`ATTEMPT_START_BUDGET_MS`, `ATTEMPT_START_SKIP_MS`), so a
  recovery reopening many tasks through an outage waits once, not once per
  task; never parked; never run on the web host in own mode, not even during
  release skew, where an older control plane's refusal is one more door error.
  - `AttemptReopened` opens a settled owner task again. `pending` is a new
    attempt of a failed task: the credential, GitHub-access and incident
    recoveries (`requeueFailedTasks`, `resumeRepoAccessBlockedTasks`), which
    name the task's latest attempt row and its end (`reopen:<task>:<worker>:
    <completed_at>`). `assigned` is the same worker running again after a
    person's follow-up (the worker PATCH's reactivation). It moves the task
    only while that worker is still its latest attempt row and its end is the
    one named, and a new attempt also needs no live attempt on the task, so a
    reopen that lands after the task was claimed again, or after the worker
    ended once more, moves nothing.
  - `AttemptWithdrawn` is a claim that does not run the attempt. With its claim
    (`claimed_by`, `claimed_at` as Postgres renders it) it gives the start back
    to the queue (`requeued`: the claim route's rollback when the account cap
    refused its worker, a claim the cleanup finds with no attempt row) or ends
    the task (`failed`: that claim at the cleanup's retry cap), only while the
    task is `assigned` under exactly that claim with no attempt row made since.
    With no claim it refuses a queued task for good (`failed`: a workspace that
    lacks the project the task is pinned to, a sandbox mount gap that ran its
    mission out of budget), only while the task is `pending`, no live claim
    holds it and no attempt runs. The claim route's rollback tells the tasks
    trigger not to wake dispatch, as its legacy write does (a transaction-local
    hint the guard's WHERE sets), so a refused claim does not loop.
  The other sites use the commands already there, for the current attempt
  only:
  - The worker PATCH's completion statement takes `status` out of its fields
    and sets it only for a task that is no delivery's owner. An output-contract
    or loop-exhausted failure override is the owner attempt's end, sent
    `failed` and projected (`t_attempt`, `projectOwnerEnd` with `failed`), and a
    failed release the same: the release statement writes its record only.
  - The cleanup route moves an owner task by its current attempt (its latest
    attempt row made at or after `claimed_at`): a requeue is `AttemptRequeued`,
    the retry-cap failure `AttemptEnded(lost)`, the promotion of a completed
    worker that worker's `AttemptEnded(success)`; with no attempt row since the
    claim, `AttemptWithdrawn` on that claim. Its stalled-worker pass moves the
    task only when a worker it timed out is that current attempt, and it
    promotes only the current attempt's completed worker, so an older worker
    that went quiet after the task was claimed again leaves the new attempt
    its task. The cap's reason is recorded on the task once the kernel failed
    it.
  - The reaper's unanswered question superseded by recovery is the attempt's
    end like any other (`AttemptEnded(lost)`): the worker failed. The incident's
    recovery then reopens the task (`AttemptReopened`).
  Every attempt writer's remaining status write is for a task that is no
  delivery's owner and says so in its own WHERE (`notOwnerTaskSql`: no
  delivery, or a repair or review of one; broader than
  `notDeliveryOwnedTaskSql` so the owner of a delivery the kill switch
  released is still moved by the guarded projection), or sits on a branch only
  a non-owner reaches. A loop's exit (`projectLoopExit`) also leaves a task with
  another PR still open (T17's rule: a stacked series completes with its last
  merge).
  The guard can no longer be passed by a status supplied through a pre-built
  object: at a routed or result-only statement every top-level spread
  (`...fields`, `...(p.set ?? {})`) and every `.set(fields)` must resolve, in
  the same file, to an object literal with no status key or to a rest binding
  that takes `status` out, and nothing may assign `fields.status`; a member,
  a parameter or anything else fails.
  With that, AC-1 is done for `tasks.status`: no attempt statement sets a kernel owner
  task's status itself (`ATTEMPT_SITE_CEILING` is 0), and a direct status write
  put back at any routed site fails CI (the guard's self-tests revert each one
  on the real file). Person writers (task PATCH, bulk, reassign, attach-PR,
  visual-review decisions, waivers, tracker webhooks) still write it as a
  person's act.
- Mission completion: `completeMissionIfVerified` from subscribers,
  `pr-reconcile.ts`, the schedules cron, evaluate, mission loop; plus mission
  PATCH, archive, circuit breaker, budget. S4b: the automated paths share one
  writer (`mission-completion-write.ts`), compare-and-set on the mission's
  delivery records: the decision fingerprints the epochs (id, version, state)
  before it reads them, and the write lands only if they are unchanged, so no
  caller completes a mission over epoch state it did not see. Every epoch
  transition touches its mission row in its own statement, and the write
  requires the row version it read (`xmin`), so an epoch write still in flight
  is seen too. After a miss on a mission still active, unchanged records mean
  another write held the row and it claims once more (`completion_contended`
  on a second miss); moved records are decided once more on a fresh read
  (`deliveries_moved` on a second miss). A
  mission with no delivery records has no fingerprint and completes as before.
  Every epoch reconcile that settles or retires a delivery (the merge door's,
  `ensureWritableEpoch`'s, the hourly one) emits `mission.delivery_settled`,
  and the missions module asks the writer to decide. The person paths (mission
  PATCH, archive) stay.
- Merge doors outside the kernel: release PR on CI green (webhook), release
  executor (two unpinned merges and a branch-to-prod merge), release compose,
  and the legacy arm of the dashboard merge, `PUT /api/github/pr`, the landing
  lane and auto-merge.
- Refresh: the clean-merge write to the mission branch and
  `dispatchBranchRefreshConflictTask`, both outside the kernel. They read
  "shipped" from epoch state for a mission with epochs (S6), and from
  `workers.mergedAt` for one that predates them.

## 10. Open questions

- Q1 (answered 2026-10-15): the package's license. The kernel package is
  Apache-2.0, like the other contract packages, so adopters can embed it. The
  product and `@buildd/core` stay FSL-1.1-ALv2.
- Q2 (answered 2026-10-13, §3): the command endpoint is a route on the
  control plane's own host, signed by the calling host and re-checked as the
  principal it names.
- Q3: whether tasks with no delivery keep their writers permanently or move
  behind a second, smaller task-lifecycle authority later. Out of scope here.

## Code surface

- `apps/web/src/lib/workflow/` (moves to the package in S1–S2)
- `apps/control-plane/src/` (hosts the kernel in S3: the command route and the cron trigger)
- `apps/web/src/lib/workflow/command-api.ts`, `command-ledger.ts`, `kernel-client.ts`, `kernel-floor.ts`, `kernel-host.ts` (S3)
- `apps/web/src/lib/workflow/kernel-telemetry.ts`, `apps/control-plane/src/axiom-export.ts` (Observability, §3)
- `apps/web/src/modules.ts` (handler composition replaced in S2)
- `apps/web/src/lib/mission-branch-refresh.ts`, `mission-pr.ts` (S6)
- `apps/web/src/lib/release-executor.ts`, `release/compose-actions.ts` (S3)
- `packages/workflow-kernel/src/open-pr-status.ts`, `apps/web/src/lib/workflow/open-pr-status.ts`, `apps/web/src/lib/release/open-pr-review.ts` (every open PR carries the review status)
- `packages/core/pr-facts.ts` (S4)
- `packages/workflow-kernel/src/delivery-summary.ts`, `apps/web/src/lib/delivery-overlay.ts`, `apps/web/src/lib/pr-delivery-report.ts` (S7)
- `packages/core/__tests__/workflow-write-sites.test.ts`,
  `state-ownership.test.ts` (kernel path changes in S1)

## Out of scope

- Changing the state machine, transitions or CAS beyond what §5 and §6 add.
- Task lifecycle for tasks with no delivery (Q3).
- Living Specs tables and approvals (`living-specs.md`).
- Dispatch's own outbox and scheduling (`task-dispatch-authority.md`).
