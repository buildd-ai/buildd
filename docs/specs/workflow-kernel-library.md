---
title: Workflow Kernel Library and Single Host
status: draft
owner: max
last_verified: 2026-10-14
summary: Delivery state MUST have one writer, the workflow kernel, packaged as a library with no buildd imports and run in production only by the execution control plane.
domain: tasks
surfaces: [apps/web/src/lib/workflow/kernel.ts, apps/web/src/lib/workflow/seam.ts, apps/web/src/lib/workflow/command-api.ts, apps/web/src/lib/workflow/kernel-client.ts, apps/web/src/lib/workflow/delivery-epochs.ts]
related: [workflow-state-kernel, execution-control-plane, mission-branch-refresh, mission-task-lifecycle, living-specs]
keywords: [scope amendment, mission scope version, workflow kernel, delivery state, single writer, single host, control plane, portable library, ports, adapters, conformance suite, merge door, landing authority, required status, durable findings, finding disposition, delivery epoch, mission delivery, refresh settlement, no-op completion, workflow-kernel package]
verified_by: [packages/workflow-kernel/src/scope-amendments.test.ts, apps/web/tests/db/kernel-pr-projection.test.ts, apps/web/tests/db/task-status-writers.test.ts, apps/web/tests/db/mission-completion-writer.test.ts, apps/web/tests/db/kernel-merge-heal.test.ts, apps/web/src/lib/workflow/pr-fact-scope.test.ts, apps/web/tests/db/scope-amendments.test.ts, packages/workflow-kernel/src/delivery-epochs.test.ts, apps/web/tests/db/mission-epochs.test.ts, packages/workflow-kernel/src/landing-gate.test.ts, apps/web/src/lib/workflow/merge-door-inventory.test.ts, apps/web/src/lib/release/pinned-merge.test.ts, apps/web/src/lib/workflow/command-api.test.ts, apps/web/src/lib/workflow/kernel-client.test.ts, apps/web/src/lib/workflow/kernel-floor.test.ts, apps/web/tests/db/kernel-command-host.test.ts, apps/web/src/app/api/cron/pr-reconcile/route.test.ts, packages/workflow-kernel/src/findings.test.ts, packages/workflow-kernel/src/conformance/conformance.test.ts]
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
  family the kernel does not know is `skipped:legacy_owns`.
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
  reads the kill switch from it on both stores. NOT IMPLEMENTED: the rest of
  the §16 matrix, §15 replay, and the #3787 and #4663/#4670 sequences as
  conformance scenarios (they run today as the epoch reducer's package tests
  and the Postgres epoch suite, §6).
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
    `drain` (one delivery's due effects, `system` principals only), and
    `mission_epoch` (§6: a mission delivery merged, ensure a writable one, bind
    its PR, reconcile what is owed; re-checked against the mission's repo
    workspace). The same
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
  one-writer work of §1 (S4), not a command to move. Ingesting a fact
  (`observePrState`, `observeHead`, attempt ended, verdicts) is not a door and
  still runs where the fact arrives; on the web host that is the render
  read-through and the sweeps, a §9 write site S3b and S4 remove.
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

**Switching over** (owner/operator steps, NOT DONE yet). Merging and
releasing this code changes nothing on its own: without the secret the web
host keeps applying commands and draining exactly as before. The order
matters: the control plane first, then the web host.

1. Set `KERNEL_COMMAND_SECRET` on the control plane Worker (a Worker secret),
   and run `wrangler triggers deploy` for it from an account login so its cron
   trigger exists (the release workflow deploys versions, not triggers).
   Confirm `/__control-plane/health` reports `kernel: own`.
2. Then set the same `KERNEL_COMMAND_SECRET` value in the web app's
   environment.
3. Confirm the switch: the `kernel-floor` cron runs report the control plane as
   their host, `/api/cron/pr-reconcile` reports `kernelSkipped`, and new
   `workflow_transitions` rows from doors carry `host = control-plane`.

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
  `apps/web/src/app/api/prs/[prNumber]/merge/route.test.ts`.
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
- AC-13 (failure): GIVEN `EXECUTION_MODE=own` and a control plane slow to
  answer WHEN a sweep makes door calls and inline drains one after another
  THEN the pass waits on the control plane no longer than its budget, the
  calls past it are refused unsent and retryable, and the pass reports each
  step's time (`kernel-client.test.ts`, and `route.test.ts` beside
  `apps/web/src/app/api/cron/pr-reconcile/route.ts`). GIVEN a command whose
  request died mid-command WHEN the next request with its key arrives a lease
  later THEN it takes the claim over and runs, while a live command's renewed
  claim is never taken over (`command-api.test.ts`,
  `kernel-command-host.test.ts`).

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
  `publish_landing_status` effect publishes the commit status `buildd/landing`.
  It is `success` only when the kernel would land that head (approved or
  landing, covered, no open verdict), and `failure` while a required finding is
  open or review is missing. One effect per delivery version; only the newest
  version's effect publishes, so a late or duplicate effect never overwrites a
  newer answer, and an effect that runs out of retries publishes `failure`,
  never leaves a success standing. CI is not part of it: CI has its own checks,
  and the merge rails never read `buildd/landing` as CI. Making it a required
  check on trunk is an owner decision, taken once every open PR carries it.
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
  notified, with the rail named on `buildd/landing`. The status is written only
  when GitHub does not already show it, and re-checked after writing so the
  newest version wins across drains.
- Release doors hold, never fail or throw, when a kernel-owned PR is not landed
  yet or the control plane does not answer; a PR the kernel does not own never
  reaches the kernel. A lost GitHub answer is indeterminate, not a refusal.
  A held release task records its PR and merge method (a held worker PR
  squashes) and is settled by the PR: completed when it merges by any door,
  failed with the reason when it closes unmerged. The hourly pr-reconcile
  merge-state pass (and the daily full pass) sweeps held tasks (`apps/web/src/lib/held-pr-tasks.ts`): a merged or closed
  PR settles, a green open one is retried through the release-on-green door,
  and a task still held after 24 sweeps fails with the reason.
- Release doors D7–D10 go through `apps/web/src/lib/release/pinned-merge.ts`
  (or the kernel, for a PR it owns): live read, refuse a head other than the
  verified one (AC-16), `guardReviewVerdict` at that head, GitHub's `sha` pin.
- D4 refuses when no workspace resolves; D5 `force` no longer skips the review
  verdict. `apps/web/src/lib/workflow/merge-door-inventory.test.ts` fails on
  any merge call not in the inventory.
- Deviation: a PR with no delivery is still merged by its door's legacy arm
  (worker doors under their own review gate; release PRs under the release
  gate above). Adopting the delivery first is the follow-up slice; release
  PRs need an owner decision, since their bookkeeping lives outside the kernel.

**Acceptance criteria**:
- AC-13: GIVEN a PR with an open required finding WHEN any of D1–D11 is asked
  to merge it THEN the merge is refused with the finding named, and the
  `buildd/landing` status at that head is `failure`.
- AC-14: GIVEN an approval at head A WHEN head B is pushed before the merge
  effect runs THEN the effect re-reads, sees B, and does not merge.
- AC-15: GIVEN a person merges on GitHub over an open finding WHEN the webhook
  arrives THEN the delivery is `MERGED` with `merged_over_open_findings`, a
  trunk fix task is filed once (idempotent on replay), and no surface shows
  "approved".
- AC-16 (failure): GIVEN the release executor merging a release PR WHEN its
  head moved after verification THEN the merge is refused, not merged
  unpinned.

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
- Deviation: no door submits `FindingDisposed` yet (no command-API op, route
  or dashboard action). The command and its rules are in the kernel; the door
  is a person-only command-API op plus a route, left out of this slice because
  the command API and its ledger are being changed by the control-plane
  cutover work at the same time. Until then a person passes an open finding
  through the landing override (rule 6).
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
  round is a round like any other: it uses one of the delivery's `maxRounds`.
  It does not skip a CI repair: an owner hand-off on a red head goes to
  `REPAIRING(ci)` first, and leaving the repair re-enters the kept verdict. The kernel's
  own open round at that head is never answered from outside (its reviewer
  does), and a verdict on another head is stale. The same head is never reviewed twice for it, and `explain`
  calls an open reviewer a review, never "Fix 0 of 3".
- Completing a fix arms a delta re-review at the new head (1bd26ae7). A fix
  that pushed from somewhere the runner cannot see reports no local head; its
  proof is §9's "L unknown" rule (the head moved off the bound head and
  descends from it), only when nothing local can be lost: a completed end or
  one with no commits (AC-10). An unproven end with commits waits for its push. A `dispatch_review` that cannot file a reviewer fails its
  round (T27, re-queued twice with a backoff, then `review_unavailable`)
  instead of leaving it open with nobody on it.
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

## 6. Mission deliveries and epochs

**Capability statement**: A mission-branch mission MUST be a sequence of
kernel-owned delivery epochs, so shipping one epoch never strands the mission's
later work and nothing refreshes or re-ships a branch that already landed.

**Invariants**:
- A mission's integration PR is a delivery of role mission, opened when the
  branch is cut (today `openMissionIntegrationPr`). #4686 is the case of a
  mission PR with none.
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
  claim); a refresh keeps the branch it was filed for.
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
- AC-23 (failure): GIVEN an open refresh PR with unique commits WHEN its epoch
  merges THEN the branch is not deleted until that PR is retargeted or
  escalated, and nothing retargets it to trunk silently (the #4670 sequence).

| AC | Test |
| --- | --- |
| AC-20 | `packages/workflow-kernel/src/delivery-epochs.test.ts` › "AC-20 / scenario 1 and 3"; `apps/web/tests/db/mission-epochs.test.ts` › "AC-20", "scenario 2" |
| AC-21 | `apps/web/src/lib/mission-branch-refresh.test.ts` › "mission delivery records (AC-21)" |
| AC-22 | `apps/web/src/app/api/workers/[id]/route.test.ts` › "mission-branch refresh already on the branch" |
| AC-23 | `apps/web/tests/db/mission-epochs.test.ts` › "AC-23 / a11abc4b"; `apps/web/src/lib/mission-pr.test.ts` › "a refresh PR lands only on the delivery it was filed for" |
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

**Acceptance criteria**:
- AC-24: GIVEN a delivery with two review rounds WHEN `get_pr`, the task page
  and the activity comment render THEN all three show the same round count,
  latest verdict and open findings.
- AC-25: GIVEN a mission whose epoch merged and has no other open work WHEN
  `explain` reads it THEN it is not "stalled".
- AC-26 (failure): GIVEN a worker row that says merged and a delivery that says
  in review WHEN any surface renders THEN it shows the delivery's state and
  flags the disagreement in `explain`.

How (S7, task c16eb202). The review line ("2 rounds · latest: changes
requested · 1 open finding") and a repair's phase are pure readings in the
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
| AC-24 | `apps/web/src/lib/projections-agree.test.tsx`; `apps/web/src/app/api/github/pr/route.test.ts` › "review rounds and standing from the delivery" |
| AC-25 | `apps/web/src/lib/explain.delivery.test.ts` › "AC-25" |
| AC-26 | `apps/web/src/lib/explain.delivery.test.ts` › "AC-26"; `apps/web/src/lib/delivery-overlay.test.ts`; `apps/web/src/lib/pr-list.test.ts` › "a kernel delivery still live" |
| Repair phases | `packages/workflow-kernel/src/delivery-summary.test.ts`; `apps/web/src/lib/task-checks.test.ts` › "repair phase (§7)" |

## 8. Order of work

Each slice is one or more reviewed PRs to trunk, built locally (mission
2e3550ab), and ends with its ACs green.

| Slice | Delivers | ACs | Existing tasks folded in |
|---|---|---|---|
| S0 | this spec, with #4693's amendments to `workflow-state-kernel.md` and `mission-task-lifecycle.md` | — | ed50e3b2, #4693 |
| S1 | package with the pure modules, boundary test, in-memory store, conformance suite on the pure core; apps/web imports from it | AC-5, AC-6, AC-8 | — |
| S2 | ports for store, GitHub, clock, work, notify, policy, decide; effect handlers move into the package; Postgres adapter runs the suite | AC-7, AC-27–AC-29 | — |
| S3 | single host: command endpoint, drain and floor on the control plane, Vercel doors submit commands; every merge door through the gate on review verdict, head and CI; release doors pinned; `buildd/landing` status | AC-9–AC-12, AC-14–AC-16 | cc59da33, 30a47173 |
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
  (`pr_open`, CI, conflict, unresolvable) stay with S4b. "Delivery-owned" has
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
  field. NOT IMPLEMENTED: `tasks.result.prUrl` / `prNumber` derived on read
  (the worker PATCH still copies them from the worker row).
- Mission completion: `completeMissionIfVerified` from subscribers,
  `pr-reconcile.ts`, the schedules cron, evaluate, mission loop; plus mission
  PATCH, archive, circuit breaker, budget. S4b: the automated paths share one
  writer (`mission-completion-write.ts`), compare-and-set on the mission's
  delivery records: the decision fingerprints the epochs (id, version, state)
  before it reads them, and the write lands only if they are unchanged, so no
  caller completes a mission over epoch state it did not see. A mission with no
  delivery records has no fingerprint and completes as before. The kernel's
  epoch path asks for the decision itself after it settles or retires a
  delivery. The person paths (mission PATCH, archive) stay.
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
- `apps/web/src/modules.ts` (handler composition replaced in S2)
- `apps/web/src/lib/mission-branch-refresh.ts`, `mission-pr.ts` (S6)
- `apps/web/src/lib/release-executor.ts`, `release/compose-actions.ts` (S3)
- `packages/core/pr-facts.ts` (S4)
- `packages/workflow-kernel/src/delivery-summary.ts`, `apps/web/src/lib/delivery-overlay.ts`, `apps/web/src/lib/pr-delivery-report.ts` (S7)
- `packages/core/__tests__/workflow-write-sites.test.ts`,
  `state-ownership.test.ts` (kernel path changes in S1)

## Out of scope

- Changing the state machine, transitions or CAS beyond what §5 and §6 add.
- Task lifecycle for tasks with no delivery (Q3).
- Living Specs tables and approvals (`living-specs.md`).
- Dispatch's own outbox and scheduling (`task-dispatch-authority.md`).
