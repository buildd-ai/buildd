---
title: Agent Question Protocol
status: active
owner: max
last_verified: 2026-10-23
summary: An agent question MUST include an actionable brief, pass the question gate and park only when human input is required.
domain: tasks
surfaces: [apps/web/src/lib/question-gate-check.ts, packages/core/needs-you.ts, apps/web/src/lib/sessionless-worker-settle.ts]
related: [human-answer-delivery, worker-reclamation]
verified_by: [apps/web/src/lib/question-subject.test.ts, packages/core/__tests__/mcp-tools-post-note.test.ts, apps/web/src/lib/recoverable-blocker-reconcile.test.ts, apps/runner/__tests__/unit/completion-replay.test.ts, apps/web/src/lib/sessionless-worker-settle.test.ts, apps/runner/__tests__/unit/worker-remote-404.test.ts, apps/web/src/lib/question-gate-check.test.ts, apps/web/src/app/api/workers/[id]/question-check/route.test.ts, packages/core/__tests__/needs-you.test.ts]
assertions:
  - id: "question-gate-check"
    type: "route"
    method: "POST"
    path: "/api/workers/[id]/question-check"
    file: "apps/web/src/app/api/workers/[id]/question-check/route.ts"
  - id: guard-1
    type: test_file
    path: apps/web/src/lib/question-gate-check.test.ts
  - id: guard-2
    type: test_file
    path: apps/web/src/app/api/workers/[id]/question-check/route.test.ts
  - id: guard-3
    type: test_file
    path: packages/core/__tests__/needs-you.test.ts
---
# Agent Question Protocol

**Capability statement**: An agent question MUST include an actionable brief, pass the question gate and park only when human input is required.

## Asking: how a worker enters `waiting_input`

**Invariants**:
- The only way a worker row reaches `waiting_input` is a runner `PATCH
  /api/workers/[id]` carrying `status: 'waiting_input'`; `waitingFor` is written
  from the same payload and is reduced to `{ type }` alone when the workspace's
  `dataClass` is `sensitive`.
- A `waitingFor.type === 'question'` payload MUST produce a human notification
  carrying a deep link to `/app/tasks/<taskId>/respond` — the question is
  useless if the only place it renders is a dashboard nobody is looking at.
- `waitingFor` MUST be cleared to `null` when the worker reports `running` and
  the payload does not restate it.
- The transition broadcasts `WORKER_PROGRESS` (not a dedicated event) on both
  the worker and workspace channels, so any surface that wants to react to
  "needs input" MUST read `status` from the payload rather than switch on the
  event name.
- **`waiting_input` does not imply a live session.** In the runner's default
  mode (`inputAsRetry !== false`) an `AskUserQuestion` tool call is terminal for
  the session: the runner awaits the `waiting_input` sync, then aborts the
  subprocess (`session.abortController.abort()`). The abort makes the SDK's
  async generator throw on its next iteration, so the code path that actually
  runs for this abort is the outer `catch` in `startSession`
  (`apps/runner/src/workers.ts`), not the post-loop cleanup branch that runs
  after the query loop exits without throwing. Both branches share one
  `parkNeedsInputAbort` helper that keeps `status: 'waiting_input'` (carrying
  `error: 'needs_input: …'` for observability) rather than dropping to
  `failed` — a parked question is not a crash. A first fix touched only the
  post-loop branch, which is unreachable for this abort in practice, so the
  abort kept reporting `status: 'failed'` in production after that fix merged
  — the misclassification, the blind mission auto-retry below, and the
  `deriveTaskPhase` precedence bug all stayed live until both call sites were
  fixed together. Reporting `failed` here used to feed the server's generic
  mission auto-retry gate (blind re-dispatch into the same unanswered
  question before any human saw it) and the failure-analytics /
  success-rate-by-role aggregates, and hid the task behind
  `deriveTaskPhase`'s failed-wins-over-waiting_input precedence
  (`apps/web/src/lib/task-presentation.ts`) instead of its dedicated
  `waiting_input` phase. Every surface that offers an answer affordance still
  keys on `waitingFor` rather than on a live status — `RealTimeWorkerView`
  renders `worker-needs-input-banner` from `worker.waitingFor` alone, which
  now agrees with `status` instead of compensating for it.
- **A worker that never reaches `waiting_input` at all — the waiting_input
  timeout — still carries its own exit cause.** `cleanupStuckWaitingInput`
  (`apps/web/src/lib/stale-workers.ts`) fails the worker with
  `exitCause: 'needs_input'` (`apps/web/src/lib/worker-exit-taxonomy.ts`), and
  the PATCH route classifies the same way for any other `status: 'failed'`
  report whose error still carries the `needs_input:` prefix
  (`classifyReportedFailure`'s `needsInput` input). `needs_input` is excluded
  from `consumesRetryAttempt` (not chargeable — the task was never actually
  attempted, only blocked) and from `failure-analytics.ts`'s failure rate,
  exit-cause breakdown and top-signature ranking (`isChargeableFailure`), but
  remains queryable via `getFailureSignatureFamily`'s `errorPrefix:
  "needs_input:"` rollup, which intentionally scans every failed/error row
  regardless of this exclusion.
- **An open ask requires a waiting worker and a nonterminal task.**
  `isOpenAsk` gates task-page question heroes, Home asks, chat cards and
  notification answer links. Retained `waitingFor` or an open question note
  alone cannot revive an ended worker. Completed, failed and cancelled tasks
  show past questions collapsed, with the recorded reply or "Not answered".
  `deriveTaskPhase` preserves a terminal outcome over any retained question.
- **A question whose session ended is a wait, not a running agent.** A
  `waiting_input` worker carrying the `needs_input:` error marker
  (`questionSessionEnded`, `packages/shared/src/status.ts`) holds no runner
  slot: the claim route's account cap (pre-check and the atomic predicate),
  `GET /api/workers/active` and the runner's heartbeat count
  (`holdsRunnerSlot` with no live session) all leave it out, as the runner's
  own claim loop already did. Health draws its bar only up to the worker's last
  write and does not count it live; the ask itself shows in Needs you. A
  question asked inside a live session (`inputAsRetry === false`) still holds
  its slot. Waiting has no arbitrary timeout beyond the existing 4h/24h one.
- **Cancelling or deleting the task closes its question.** A live worker with
  no session to report its own end (a session-ended question, a pause, a
  parked run) is settled by the server in the same request
  (`lib/sessionless-worker-settle.ts`): compare-and-swap to `failed`,
  `exitCause: 'task_cancelled'`, `waitingFor: null`, `completedAt` stamped,
  then the seat, a `worker:failed` event and a capacity wake, once per row
  moved. The row and its milestones stay as history. A worker with a live
  session gets the abort push and reports its own end. Delete settles before
  the row goes, since it sets `workers.task_id` to NULL. A late `/respond` is
  refused (no `waitingFor`), and the waiting-input timeout never fails a
  terminal task or files a retry of it. `/api/cron/waiting-input-sweep` first
  settles any such row left behind (task deleted or terminal), whatever its age.
- **The runner never forgets a parked question by mistake.** Its reconcile
  reads `null` from `getWorkerRemote` as "deleted on the server". Only a 404
  body means that; a worker row whose own `error` column carries
  `needs_input:` is a parked question, not a 404.
- **A task's open question is one card on every surface.** The task page,
  the Board and the timeline all answer with
  `TaskQuestion` (`apps/web/src/components/tasks/TaskQuestion.tsx`), which
  folds `waitingFor` and the question note recording the same ask
  (`linkQuestionNote`) into one question. The note's title leads, its
  default choice is the recommendation, and an answer marks it answered
  through the same `submitAnswer` path. The task page loads the linked note
  through `loadTaskView`; mission links open that page with their back context.
- **The mission auto-retry gate excludes `needs_input`.** The PATCH route's
  per-task auto-retry (`shouldAutoRetry`, gated on `status === 'failed'`) must
  never blind-requeue a task whose failure is a parked question — that
  re-dispatches a worker into the same unanswered question before a human
  ever sees it, wasting a worker and discarding the question. This should be
  structurally unreachable now that the abort itself reports
  `waiting_input`, not `failed`; the exemption is defense-in-depth for the
  remaining `status: 'failed'` paths above.
- **A contentless question is a contract violation, not a silent accept.**
  When the PATCH route persists a `waitingFor.type === 'question'` payload
  whose `prompt` is empty, whitespace-only, or the runner's own fallback text
  (`'Awaiting input'` — used when `AskUserQuestion` was called with no
  `question` text), it stamps `waitingFor.contractViolation: true` in the
  same write. The flag is a boolean, not prose, so it survives the
  `sensitive`-workspace redaction that otherwise drops `prompt` to `{ type }`
  alone.
- **A question carries an optional decision brief** (`packages/core/question-brief.ts`):
  `context` (at most two sentences: the task and the exact decision), a
  one-line `consequence` per option, `recommended` (`{ label, reason }`) and
  `where` (task title, branch, last edited file). The runner derives it
  deterministically from the AskUserQuestion input (framing sentences before
  the final question, each option's description, a `(Recommended)` label
  suffix) and its own facts; it never invents text. The PATCH route sanitizes
  and caps every brief field and drops malformed ones rather than refusing the
  park. Every question surface renders it, and a question without one renders
  as before. The notification is the question, one line of context and the
  recommended default.
- **The question gate runs unconditionally for every workspace**
  (docs/design/human-question-gate.md), gated only by one workspace kill
  switch (`WorkspaceGitConfig.jevQuestionGate === false`; absent/true is on).
  It used to be an opt-in experiment (`question_gate`); that plumbing (claim-time
  arm draw, control/shadow branch, `experiment_assignments` row) is gone —
  concluding or never running one now has no effect on the gate's behaviour.
  A runner whose claim carries a `questionGate` marker (a pure capability
  marker now — see `apps/web/src/app/api/workers/claim/question-gate.ts`) asks
  `POST /api/workers/[id]/question-check` before parking; handleMessage then
  leaves parking to the PreToolUse hook. One deterministic step, then two stages:
  0. **Recover instead of asking.** A question whose own text describes a
     recoverable platform blocker (`packages/core/human-attention.ts`
     `classifyRecoverableBlocker` — a migration below the high-water mark or
     out of order, a merge conflict with the base, missing/stale generated
     state, a transient 5xx or rate limit, CI already red on the base and not
     this change's doing) and with no hard rail is NOT parked or notified. A
     repair task is filed, or the live one reused (one per blocker kind per
     mission, else per workspace; `apps/web/src/lib/recoverable-blocker-repair.ts`,
     wired into the gate's `fileRepair` slot by `apps/web/src/modules.ts`),
     the blocked task is recorded on it, and the agent gets an answer naming the
     repair and telling it to carry on (its recommended option when it gave one)
     or finish blocked on it. Verdict `decide`, outcome `recovered`, recorded
     `reason: 'recovered:<kind>'`. No model call, so it runs for sensitive
     workspaces too. A filing failure falls through to the stages below.
     A session that already ended cannot take that answer, so the runner
     parks it `recovered` instead. That park is a wait on the repair, not a question:
     the task page shows the repair, not an Answer form, and explain() reports
     a `self_resolving_wait`, not `awaiting_decision`. When the repair task
     completes, every worker still parked on it (`waitingFor.repairTaskId`) is
     closed `superseded_by_recovery` and its task requeued
     (`apps/web/src/lib/recoverable-blocker-reconcile.ts`, the same
     close-and-requeue pair a failure incident's recovery uses). The retry is
     told what the repair found, so work the repair confirmed shipped
     completes with `alreadyShippedIn`, not a second PR. A park that arrives
     after its repair already completed is resumed by the park's own PATCH.
  1. **Brief check.** A confident `needs_context` from the decision model
     (default threshold 0.7, unmeasured, `DEFAULT_QUESTION_GATE_MIN_CONFIDENCE`)
     is NOT parked or notified: the pushback text is the AskUserQuestion tool
     result and the agent asks again. At most `DEFAULT_QUESTION_GATE_MAX_PUSHBACKS`
     (default 2) per worker, then the question proceeds to stage 2 instead of
     being sent as-is.
  2. **Decide / hold / ask.** Once the brief clears (or the pushback cap is
     spent) and no hard rail applies (`packages/core/question-gate.ts`
     `detectHardRail` — migrations, auth/secrets, CI/deploy config, the
     workspace's own declared protected paths, and a text heuristic for
     spending), a second decision (`QUESTION_DECIDE_DECISION`) picks the
     disposition: `decide` (Jev picks one of the listed options; the answer is
     the AskUserQuestion tool result, verdict `decide` — nobody is parked or
     notified), `hold` (parked like `ask`, tagged `disposition: 'hold'` with a
     `holdReason` and a `resurfaceAt` at most `HOLD_RESURFACE_MS` out, but
     nobody is notified when it parks — `apps/web/src/lib/question-hold.ts`
     surfaces it at the deadline if it is still unanswered), or `ask` (parked and notified,
     unchanged). Low confidence, an invalid/missing option index, or a
     question with no options all fail open to `ask`.
  Every failure at either stage (sensitive workspace, no key, gateway decision
  model, timeout, transport error) sends the question unchanged. Stage 2's
  answered calls are recorded as `decision_records` rows
  (`packages/core/decision-ledger.ts` `recordDecision` — the one ledger every
  other Jev decision in buildd uses) with a hard rail recorded as
  `reason: 'rail_blocked:<rail>'`; every provider call at either stage also
  writes its `ai_usage` receipt. A human can correct a recorded decision via
  `recordHumanOverride` / `POST /api/decisions/[id]/override`.

- **One normalized question, never context-free.** Task detail, Home (desktop
  and phone Needs-you cards) and chat all render `unifyWorkerQuestion`
  (`apps/web/src/app/app/(protected)/tasks/[id]/question-hero.ts`). When the
  stored brief has no context, it is rebuilt from the worker's own
  `needs_input:` error (which carries the full question text, framing included)
  or another reported error, else "Asked while working on <task>"
  (`fallbackQuestionContext`). Home's card leads with that context, never a
  generic line, and keeps structured options and the recommended default.

**Acceptance criteria**:
- AC-1: GIVEN a runner PATCH with `status: 'waiting_input'` and
  `waitingFor: { type: 'question', prompt, options }` WHEN the row is written
  THEN `GET /api/tasks/waiting-input` returns that task with its `waitingFor`
  and an `actionUrl` ending `/respond`.
- AC-2: GIVEN a `sensitive` workspace WHEN the same PATCH is received THEN
  the stored `waitingFor` contains `type` only and the notification body carries
  no prompt prose.
- AC-3: GIVEN a worker in `waiting_input` WHEN a PATCH with
  `status: 'running'` and no `waitingFor` key arrives THEN `waitingFor` is set
  to `null` in the same update.
- AC-32: GIVEN a `session.abortController.abort()`-triggered thrown
  AbortError for a `needs_input:`-prefixed `worker.error` (the actual runtime
  path, not the post-loop-exit path) WHEN the runner's outer catch handles it
  THEN the worker is reported `status: 'waiting_input'`, never `'failed'`.
- AC-33: GIVEN a `waiting_input` timeout (`cleanupStuckWaitingInput`) or
  any `status: 'failed'` report whose error starts with `needs_input:` WHEN
  the worker row is written THEN `exitCause` is `'needs_input'`, it is
  excluded from `failure-analytics.ts`'s failure rate and top-signature
  ranking, and it does not consume a retry attempt
  (`consumesRetryAttempt`), but remains retrievable via
  `getFailureSignatureFamily(errorPrefix: "needs_input:")`.
- AC-34: GIVEN a mission task whose worker reports `status: 'failed'`
  with a `needs_input:`-prefixed error WHEN the PATCH route evaluates its
  auto-retry gate THEN `shouldAutoRetry` is `false` — the task is not
  blind-requeued ahead of a human answering.
- AC-35: GIVEN a nonterminal task and `workerStatus: 'waiting_input'`
  WHEN its question is rendered THEN the ask is open; GIVEN a completed,
  failed or cancelled task, or an ended worker, with a retained question
  WHEN task, Home, chat or needs-input surfaces render THEN no answer control
  or open-ask count is offered. Past questions are collapsed with the recorded
  reply or "Not answered". A retained prompt alone never overrides task phase.
- AC-36: GIVEN a `waitingFor.type === 'question'` payload whose `prompt`
  is empty, whitespace-only, or the literal runner fallback `'Awaiting input'`
  WHEN the PATCH route persists it THEN the stored `waitingFor` carries
  `contractViolation: true`; GIVEN a real question text THEN the field is
  absent.
- AC-37: GIVEN a question PATCH with brief fields WHEN the route persists
  it THEN well-formed `context` / `recommended` / `where` / option
  `consequence` are stored capped, malformed ones are dropped, and the
  notification message is the prompt, one context line and
  `Recommended: <label>. <reason>`.
- AC-38: GIVEN a gated worker WHEN the gate returns `pushback` and the
  worker has pushbacks left THEN the PreToolUse hook denies AskUserQuestion
  with the pushback text and nothing is parked; GIVEN a `decide` verdict THEN
  the hook denies AskUserQuestion with the answer as the reason, nothing is
  parked, and the pushback count is untouched; GIVEN any other `send` (the cap
  reached, `hold`, `ask`, a hard rail, or any gate failure) THEN the question
  is parked, carrying the `hold` tag when the disposition was `hold`.
- AC-39: GIVEN the workspace kill switch (`jevQuestionGate: false`) WHEN
  a question is checked THEN it is sent and nothing is recorded or called;
  GIVEN it is unset or true (every workspace, by default) THEN the brief check
  and decide/hold/ask both run, with no experiment required.
- AC-40: GIVEN a task whose pathManifest touches a migration, auth/secrets
  or CI/deploy path, or the workspace's own declared protected path, or a
  question whose text reads as a spending decision, WHEN stage 2 runs THEN
  `decide` is never attempted — the outcome is `hard_rail`, the disposition is
  `ask`, and a `decision_records` row is written with
  `reason: 'rail_blocked:<rail>'`, `applied: false`.
- AC-46: GIVEN a question parked with `disposition: 'hold'` WHEN the
  worker PATCH stores it THEN nobody is notified and no `task.needs_input` row
  is recorded, unless the workspace is sensitive, the kill switch is off, or a
  hard rail applies to the task's pathManifest or the question's text — then
  the hold tag is stripped and it is notified as an `ask`, whatever the runner
  sent. Its `resurfaceAt` is clamped to at most `HOLD_RESURFACE_MS` from the
  first park, and a re-sent copy keeps the first deadline. WHEN `resurfaceAt`
  passes and the worker is still `waiting_input` on that question THEN the
  resurface pass (riding `/api/cron/notify-away`'s gated and floor ticks)
  notifies exactly once; a worker that moved on is never notified, and one
  whose task closed is settled as dropped.
- AC-41: GIVEN a confident `decide` with a valid option index WHEN stage 2
  resolves THEN the reply's `verdict` is `decide` (not `send`), `decision`
  names the chosen option and its confidence, and a `decision_records` row is
  written `applied: true`, `status: 'applied'`.
- AC-42: GIVEN a question whose text describes a recoverable platform
  blocker and no hard rail applies WHEN the gate checks it THEN a repair task is
  filed or reused, the reply is verdict `decide` / outcome `recovered` naming
  that task, nobody is parked or notified, and a `decision_records` row is
  written with `reason: 'recovered:<kind>'`; GIVEN a hard rail THEN it is still
  asked; GIVEN the filing fails THEN the normal stages run.
- AC-43: GIVEN a parked question whose detail lives only in the brief
  context or the worker's `needs_input:` error WHEN Home, task detail or chat
  render it THEN the card shows that context, not just the question and a
  generic line.
- AC-44 (Needs You admission, `packages/core/needs-you.ts`):
  a card appears in Needs You — Home's fleet questions and action queue, the
  `/api/tasks/waiting-input` feed behind the needs-input banner, the DECIDE
  chip — and the needs-input notification fires, only when a human-attention
  disposition says a person owns the next move: `ask`, or `hold` once its
  `resurfaceAt` passed. `recovered` (a repair task owns it) and a park with no
  disposition are never admitted. GIVEN any `waitingFor` WHEN the worker PATCH
  stores it (`apps/web/src/lib/park-disposition.ts`) THEN it carries one: a
  permission/confirmation prompt is `ask`; a gate-tagged `ask`/`hold` keeps the
  gate's disposition (a hold the server will not honour becomes `ask`); a
  runner-tagged `recovered` stands only when its `repairTaskId` is a task in the
  workspace; an untagged question (a runner without the `question_gate`
  feature, a failed gate call) is re-checked server-side — kill switch, hard
  rails, stage 0 — with no model call, and a recoverable blocker files or
  reuses its repair task and is stored `recovered`, nobody notified. A
  sensitive workspace keeps the disposition fields and drops the prose.
- AC-52: GIVEN a `waiting_input` worker whose session ended
  (`needs_input:` marker) WHEN the account cap is checked at claim THEN it
  does not count; GIVEN a question inside a live session THEN it does.
- AC-53: GIVEN a task with a session-ended question WHEN it is cancelled or
  deleted THEN the worker is `failed` with `exitCause: 'task_cancelled'`,
  `waitingFor: null` and `completedAt` set, its seat is released once, and a
  repeat moves nothing. GIVEN such a row left from before THEN the waiting-input
  sweep settles it before its timeout runs, and the timeout never fails a
  cancelled task or files a retry of it.
- AC-54: GIVEN the runner's reconcile reads a parked worker whose row carries
  `error: 'needs_input: …'` THEN `getWorkerRemote` returns the row, not `null`,
  and the local worker stays parked.
- AC-55: GIVEN a worker parked `recovered` on repair task R WHEN R
  completes THEN the worker is failed `superseded_by_recovery` (its question
  kept as history), its task is requeued with `context.failureContext` naming R
  and what R reported, and a repeat completion moves nothing; GIVEN the park
  lands after R completed THEN that PATCH resumes it the same way. While parked,
  explain() reports `self_resolving_wait` naming R (never `awaiting_decision`
  or `human_decision`), and the task page shows R with no Answer form.
- AC-56: GIVEN the agent's `complete_task` returned a transport error
  (ECONNRESET, a 5xx) WHEN its session ends THEN the runner does not classify
  it as a session that delivered nothing: it reads the worker back and, if the
  server already holds it `completed` (the call landed before the reset),
  sends nothing; otherwise it replays the same completion (`viaCompleteTask`,
  `summarySource: 'agent'`, `alreadyShippedIn` kept) at most three times,
  confirming each by read-back (`apps/runner/src/completion-replay.ts`). A
  landed completion takes the ordinary completed path: no question gate, no
  `waiting_input`, no repair task. A 4xx is the server's decision and is not
  retried; an unreachable server falls through to the existing session-end
  handling. A `complete_task` carrying `error` is never replayed.
- AC-45: GIVEN an agent or outside caller posts a `question` note
  (`post_note`) WHEN the notes route stores it
  (`apps/web/src/lib/note-question-disposition.ts`) THEN it carries
  `mission_notes.disposition`: `recovered` (stored answered, the agent told
  which repair task owns it) for a recoverable blocker with no hard rail and a
  task to name, else `ask`; only `ask` reaches the DECIDE chip. A person's or
  the system's notes carry none and are unaffected.

**Code surface**:
- `apps/web/src/app/api/workers/[id]/route.ts` `PATCH`: the `waitingFor`
  write (sensitive redaction, `isContentlessQuestion` sets the
  contract-violation flag, `disposeParkedWaitingFor` sets `parkAdmitted`), the
  `needsAttention` notify with the respond link, the auto-clear when a
  `running` report does not restate `waitingFor`, the classify call site (`isNeedsInput` /
  `classifyReportedFailure`), mission auto-retry gate (`isNeedsInput` exemption
  on `shouldAutoRetry`)
- `apps/runner/src/workers.ts`: `AskUserQuestion` handling (sets
  `worker.error = 'needs_input: …'` and calls `abortController.abort()`),
  `parkNeedsInputAbort` (shared helper — parks as `waiting_input`), called
  from both the post-loop cleanup branch AND the outer `catch`'s
  `isAbortError` handling — the latter is the path that actually fires in
  production for this abort
- `apps/web/src/lib/worker-exit-taxonomy.ts` (`needs_input` exit cause,
  `classifyReportedFailure`'s `needsInput` input, `consumesRetryAttempt`
  exclusion)
- `apps/web/src/lib/failure-analytics.ts` (`isChargeableFailure` — excludes
  `needs_input` from the failure rate / signature ranking while
  `buildSignatureFamily` still scans it)
- `apps/web/src/lib/stale-workers.ts` (`cleanupStuckWaitingInput` writes
  `exitCause: 'needs_input'`)
- `apps/web/src/lib/task-presentation.ts` (`deriveTaskPhase` — terminal
  outcome wins over a retained question)
- `apps/web/src/lib/open-ask.ts` (`isOpenAsk`, `isOpenQuestionNote`,
  `recoveredRepairTaskId`)
- `apps/web/src/lib/recoverable-blocker-reconcile.ts` (AC-55, called from the
  worker PATCH on a repair task's completion and on a late park)
- `apps/runner/src/completion-replay.ts` (AC-56, called from
  `apps/runner/src/workers.ts` before the session-end branches)
- `apps/web/src/app/api/tasks/waiting-input/route.ts`
- `apps/web/src/app/app/(protected)/tasks/[id]/RealTimeWorkerView.tsx`
  (`worker-needs-input-banner`), fixtures at
  `apps/web/src/app/app/dev/fixtures/fixtures-data.ts`

---

## Asking from an interactive session: `ask_human` and `await_answer`

A worker claimed with `claim_task` from a person's own session
(`workers.runner = 'mcp'`) has no runner and no `AskUserQuestion` park. It
asks with the MCP action `ask_human` and waits with `await_answer`.
`docs/specs/answered-question-resume.md` owns how its answer is delivered
(AC-32 to AC-48 there). This section states only how it enters the protocol.

**Invariants**:
- `ask_human` parks through the same route as a runner: it sends
  `PATCH /api/workers/[id]` with `status: 'waiting_input'` and
  `waitingFor: { type: 'question', prompt, options?, context?, subjectTaskId? }`. So the
  question gets the same brief handling, Needs you admission, `needsAttention`
  push and answer link as a runner's question. There is no second park path.
- `ask_human` is refused for a runner-managed worker (any `runner` other than
  `mcp`): that agent asks with `AskUserQuestion`, and its runner owns the park
  and the resume. It is also refused for a worker that has already ended.
  A refusal writes nothing.
- After parking, `ask_human` asks `POST /api/workers/[id]/answer/capability`
  for a `waitCommand`: one shell command, bound to this one question, that the
  session runs in the background. It exits 0 once the question is answered and
  non-zero with a reason otherwise, and costs no model turns while it waits.
  Minting it is best effort. Without it the session waits with `await_answer`.
- `await_answer` (`POST /api/workers/[id]/answer`, `readInteractiveAnswer` in
  `apps/web/src/lib/await-answer.ts`) long-polls for at most 45 seconds per
  call and reads the answer from its durable record, so it returns once and is
  then marked read. It is refused for a runner-managed worker. Each call is the
  session's heartbeat: a session that stops polling has its answer sent to a
  follow-up task instead.
- A session's `receive_messages` polls while parked do not move the park
  clock (`keepsParkClock`), so an unanswered interactive question expires on
  the same clock as any other: 24 hours, or 4 hours on a mission task.

**Acceptance criteria**:
- AC-50: GIVEN a worker whose `runner` is not `mcp` WHEN `ask_human` is
  called THEN it is refused, telling the agent to use `AskUserQuestion`, and
  no PATCH is sent.
- AC-51: GIVEN an interactive worker WHEN `ask_human` is called THEN the
  worker is `waiting_input` with `waitingFor.type === 'question'` through
  `PATCH /api/workers/[id]`, and the reply carries `waiting: true` and, when
  the server can sign one, a `waitCommand`.

**Code surface**:
- `packages/core/mcp-tools.ts` (`ask_human`, `await_answer`)
- `apps/web/src/app/api/workers/[id]/answer/route.ts`,
  `apps/web/src/app/api/workers/[id]/answer/capability/route.ts`,
  `apps/web/src/app/api/workers/[id]/answer/wait/route.ts`
- `apps/web/src/lib/await-answer.ts` (`readInteractiveAnswer`),
  `apps/web/src/lib/answer-wait-capability.ts`
- `apps/web/src/app/api/workers/[id]/route.ts` (`keepsParkClock`)

## The shape of a decision: title, options, subject

Every surface renders a decision as one card (Navigation: one place per task,
R-16): the task it belongs to, a summary, the question, a primary option and
one alternative, each with a one-line effect. This section is the write side:
what an agent must send for that card to exist.

**Invariants**:
- The question names the decision ("How should Docker Hub credentials be set
  up?"), never "How should I proceed?". A question whose whole text is a
  request for direction (`isGenericDecisionTitle` in
  `packages/core/human-attention.ts`) still parks, flagged
  `waitingFor.genericTitle: true`; `ask_human` and `post_note` return an
  advisory saying so. Advisory only: never a refusal.
- Options: two by default, the recommended action and one alternative; a third
  only for a genuinely different choice. `ask_human` and `post_note` refuse
  more than three, and refuse "Not now" / "Skip" as an option, with a message
  telling the agent to cut to two or ask in free text
  (`normalizeDecisionOptions` in `packages/core/question-brief.ts`). The
  notes routes refuse the same. Strings stay accepted as bare labels.
- Each option's `consequence` (one to three sentences: what happens next and
  what stays blocked) is stored with a short `effect` under 40 characters for
  the button line: the agent's own, else the consequence's first sentence.
  A runner's `AskUserQuestion` option description gets the same `effect`.
- `subjectTaskId` names the task a decision is about when it is not the
  asker's own (an organizer asking about a build task). It is checked on
  write: same mission, or same workspace for a question with no mission
  (`apps/web/src/lib/question-subject.ts`); a task outside is refused with
  400. Stored on `waitingFor.subjectTaskId` and `mission_notes.subject_task_id`;
  a note's structured options on `mission_notes.options`. Absent, the card
  falls back to the mission.
- `QUESTION_BRIEF_GUIDANCE`, the `ask_human` / `post_note` docs, the
  organizer's planning context and the `task-lifecycle` guidance topic all
  state these rules and never ask for three options by default.

**Acceptance criteria**:
- AC-57: GIVEN an agent asks with four options through `ask_human` or
  `post_note` WHEN the call is made THEN it is refused with a message to cut
  to two, and nothing is parked or stored.
- AC-58: GIVEN an option labelled "Not now" or "Skip" WHEN asked THEN it is
  refused.
- AC-59: GIVEN an organizer `post_note` question with `subjectTaskId` of a
  task in its mission and two structured options WHEN posted THEN the note
  stores the subject, both options with consequence and effect, and the
  recommended option as `defaultChoice`; GIVEN a task from another mission
  THEN it is refused with 400.
- AC-60: GIVEN a question "How should I proceed?" WHEN parked THEN it parks
  with `genericTitle: true`; GIVEN "How should Docker Hub credentials be set
  up?" THEN no flag.

**Code surface**:
- `packages/core/question-brief.ts` (`normalizeDecisionOptions`,
  `DECISION_OPTIONS_GUIDANCE`, `DECISION_TITLE_GUIDANCE`)
- `packages/core/human-attention.ts` (`isGenericDecisionTitle`,
  `decisionTitleAdvisory`)
- `apps/web/src/lib/question-subject.ts`,
  `apps/web/src/app/api/missions/[id]/notes/route.ts`,
  `apps/web/src/app/api/tasks/[id]/notes/route.ts`
- `apps/web/src/lib/mission-prompts.ts` (`decisionQuestions`)

---

**Out of scope**: The sibling contracts linked in the frontmatter.
