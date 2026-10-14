---
title: Workflow Kernel Library and Single Host
status: draft
owner: max
last_verified: 2026-10-14
summary: Delivery state MUST have one writer, the workflow kernel, packaged as a library with no buildd imports and run in production only by the execution control plane.
domain: tasks
surfaces: [apps/web/src/lib/workflow/kernel.ts, apps/web/src/lib/workflow/seam.ts, apps/web/src/lib/workflow/command-api.ts, apps/web/src/lib/workflow/kernel-client.ts]
related: [workflow-state-kernel, execution-control-plane, mission-branch-refresh, mission-task-lifecycle, living-specs]
keywords: [workflow kernel, delivery state, single writer, single host, control plane, portable library, ports, adapters, conformance suite, merge door, landing authority, required status, durable findings, finding disposition, delivery epoch, mission delivery, refresh settlement, no-op completion, workflow-kernel package]
verified_by: [apps/web/src/lib/workflow/command-api.test.ts, apps/web/src/lib/workflow/kernel-client.test.ts, apps/web/src/lib/workflow/kernel-floor.test.ts, apps/web/tests/db/kernel-command-host.test.ts]
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
spec amends where those run and who else may write.

| Spec | Relationship |
|---|---|
| `workflow-state-kernel.md` | behavioural contract the library implements. §10.3 drain hosting, §11 floor hosting, §13.12 "server-side (`apps/web`)", AC-7 and §14 are amended by §1 and §3 here. §13.13 rule 6, rule 7, rule 10 and its D1–D13 inventory are the landing authority of §4. |
| `execution-control-plane.md` | §1 "same handlers, second host" and the seven-route limit are amended by §3; §3's kernel path becomes the package path. |
| `mission-branch-refresh.md` | keeps the `branchRefresh*` columns; the refresh becomes a kernel effect of a mission delivery (§6). Its "does not model epochs" note is answered by §6. |
| `mission-task-lifecycle.md` | AC-11y's door list is replaced by §4; mission completion reads delivery state (§6). |
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
  `trunk_incidents`); and, for any task that has a delivery, the lifecycle
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
  and burns down to zero by slice S4. A guard test
  (NOT IMPLEMENTED: the delivery-columns write-site test, extending
  `workflow-write-sites.test.ts`) fails on a new one.

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
  the §16 matrix, §15 replay, and the #3787 and #4663/#4670 sequences.
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
    `drain` (one delivery's due effects, `system` principals only). The same
    code runs on the web host in shadow, so the two modes cannot drift.
  - Authenticated. The request is signed: HMAC-SHA256 over timestamp, method,
    path and body (the scheme Dispatch callbacks use, `@buildd/dispatch-contract`)
    with the dedicated command key ring `KERNEL_COMMAND_SECRET`
    (`keyId:secret[,keyId:secret]`, two ids live during rotation). The secret is
    required: nothing is derived from another secret, and while it is unset the
    control plane refuses every request (503 `unconfigured`). A bad or missing
    signature is a 401, before anything runs. The body names the
    principal the calling host vouches for (`user`, `account` or `system`),
    and the endpoint re-checks that it still reaches the workspace (team
    membership for a person, workspace reach for an API account); a principal
    that does not is a 403. The door keeps its own authorisation; the endpoint
    proves who it acts for.
  - Idempotent on a caller-supplied key. The key is claimed in Postgres
    (`workflow_commands`, `command-ledger.ts`) before the operation runs,
    never in Worker memory. A second request with the key waits for the first
    and receives its stored answer with `replayed: true`; one still running
    past the wait answers 409 `in_progress` (retryable, same key). The same key
    with a different request is a 422. An operation that throws stores
    nothing, so the key may be retried. A claim older than the lease (two
    minutes) belongs to an isolate that died and is taken over; completion is
    recorded only for the claim that still holds the key. Keys are kept seven
    days.
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
  error says what is known: `not_applied` when no request reached the control
  plane, `unknown` when one may have (a timeout, `in_progress`, a 5xx). An
  unknown outcome carries the idempotency key: retrying with that key returns
  the control plane's answer and never applies the command twice.
- Doors that run on Vercel today (dashboard and chat merge, MCP `merge_pr`,
  `create_pr`, re-review, retry-CI, apply-recommendation, supersession,
  `update_task` on a delivery-owned task, `correct_task_result`) submit a
  command through that client and return its result. Every caller of a door
  command goes through it, the landing sweep, auto-merge, the policy-merge
  rule, operator recovery and the PR subscribers included; a module outside
  the kernel that imports one from the seam fails
  `packages/core/__tests__/workflow-write-sites.test.ts`. A person's door names
  them as the principal; a door's `Idempotency-Key` header, when sent, is the
  command's key, and one key covers the whole door call: on an `unknown`
  outcome the door submits again with that same key (twice more at most)
  before it answers 503, and that 503 carries the key. `update_task` and `correct_task_result` issue no kernel
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
  with a short timeout and cached for 30 s; a reading up to five minutes old
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
- GitHub enforces the verdict: on every kernel-owned PR head the control plane
  publishes a commit status (NOT IMPLEMENTED: context `buildd/landing`)
  that is `success` only when the kernel would land that head, and `failure`
  while a required finding is open or review is missing. The status is a
  required check on the workspace's trunk once every open PR carries it.
- A merge observed by webhook that no buildd door made is recorded as an
  external merge: `MERGED` with the merger, the head, and
  `merged_over_open_findings` when any were open, plus a fix task against
  trunk for those findings (§13.13 rule 10). It is never projected as
  "approved". `measureMergeAgainstReview` keeps recording the bypass.

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
  that touches a finding's path or on a verified no-op (a live read at the
  current head showing the finding's condition is already absent, recorded
  as evidence). A zero or unrelated diff is refused, the attempt counts
  against the round limit, and every surface shows it as "no change", never
  "fix finished".
- The activity comment and `get_pr` / `get_pr_review` list findings with their
  disposition, the commit that addressed each, and the round that verified it.
  "Fix attempt n of m" counts attempts, never findings.

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

**Capability statement**: A mission-branch mission MUST be a kernel delivery
with ordered epochs, so shipping one epoch never strands the mission's later
work and nothing refreshes or re-ships a branch that already landed.

**Invariants**:
- A mission's integration PR is a delivery of role mission, opened when the
  branch is cut (today `openMissionIntegrationPr`). #4686 is the case of a
  mission PR with none.
- Epochs: the mission delivery has an ordered sequence of epochs, each one
  integration branch and PR. At most one epoch is writable. When an epoch
  merges, the kernel rotates idempotently: it settles the shipped epoch, and
  if the mission has unshipped work it cuts the next epoch from trunk and
  retargets that work, as one transition keyed on the merged head (task
  f3bda4e1). A merged epoch is terminal; the mission is not.
- Scope amendments: adding a task to a mission whose current epoch is in
  review or landing is an explicit amendment recorded on the mission (version,
  actor, reason) and goes to the next epoch unless the amendment says
  otherwise.
- Refresh is a kernel effect of the writable epoch, and it reads "shipped"
  from delivery state. It never runs for a merged epoch. This replaces the
  `findMissionPrOwner` / `workers.mergedAt` check in
  `refreshMissionIntegrationBranch` and the unchecked `reserved` path.
- A clean refresh merge is a recorded fact on the delivery (head moved by
  refresh, not a fix, §13.13 rule 5).
- A conflicted refresh files one pinned builder (single-flight per epoch and
  trunk head). If it finds the branch already contains trunk it completes as
  a verified no-op with the ancestry as evidence, no PR required.
- Before an epoch's branch is deleted, the kernel settles every open refresh
  PR against it: proven redundant (its tree is contained in the merged
  epoch) is closed with the satisfying PR recorded; unique work is retargeted
  to the next epoch; ambiguous work escalates (task a11abc4b).
- Mission completion reads delivery and epoch state, never
  `workers.mergedAt`.

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
  `dead-pr-shutdown.ts`. Becomes a fact funnel only.
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
  evidence and shipped stores.
- Mission completion: `completeMissionIfVerified` from subscribers,
  `pr-reconcile.ts`, the schedules cron, evaluate, mission loop; plus mission
  PATCH, archive, circuit breaker, budget.
- Merge doors outside the kernel: release PR on CI green (webhook), release
  executor (two unpinned merges and a branch-to-prod merge), release compose,
  and the legacy arm of the dashboard merge, `PUT /api/github/pr`, the landing
  lane and auto-merge.
- Refresh: the clean-merge write to the mission branch and
  `dispatchBranchRefreshConflictTask`, both outside the kernel, deciding
  shipped from `workers.mergedAt`; the completion gate's "refresh already
  landed" arm uses `isAncestor`, which reads null once the branch is deleted.

## 10. Open questions

- Q1: the package's license. `@buildd/spec-contract` is Apache-2.0 while the
  repo is FSL-1.1-ALv2. Recommendation: the kernel package stays under the
  repo's FSL, so embedding is free and a competing hosted service is not
  during the FSL window; the conformance suite and port types carry Apache-2.0
  so an adopter's adapter code is unencumbered. Owner decides.
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
- `packages/core/__tests__/workflow-write-sites.test.ts`,
  `state-ownership.test.ts` (kernel path changes in S1)

## Out of scope

- Changing the state machine, transitions or CAS beyond what §5 and §6 add.
- Task lifecycle for tasks with no delivery (Q3).
- Living Specs tables and approvals (`living-specs.md`).
- Dispatch's own outbox and scheduling (`task-dispatch-authority.md`).
