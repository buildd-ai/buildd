---
title: Answered-Question Resume
status: active
owner: max
last_verified: 2026-09-20
summary: Answering a parked worker's question MUST resume that worker's own session when the runner still holds it, and MUST fall back to a cold continuation only for a recorded, owner-visible reason.
domain: runners
surfaces: [apps/web/src/lib/answer-resume.ts, apps/web/src/app/api/workers/[id]/respond/route.ts, apps/runner/src/recovery.ts, apps/web/src/lib/answer-credential-preflight.ts]
related: [human-in-the-loop-protocol, runner-liveness, codex-backend-spec, credential-refresh-lifecycle]
keywords: [resume, sessionId, codexThreadId, waiting_input, Continue task, superseded, pendingInstructions, answerDelivery, cold continuation, AskUserQuestion, transcript]
verified_by: [apps/web/src/lib/answer-resume.test.ts, apps/web/src/app/api/workers/[id]/respond/route.test.ts, apps/web/src/lib/answer-credential-preflight.test.ts, apps/web/src/lib/stale-workers.test.ts, apps/runner/__tests__/unit/worker-manager-state.test.ts, apps/runner/__tests__/unit/backends/claude-backend.test.ts, apps/runner/__tests__/unit/backends/codex-resume.test.ts, apps/runner/__tests__/unit/resume-credential-preflight.test.ts]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "respond-to-worker"
    type: "route"
    method: "POST"
    path: "/api/workers/[id]/respond"
    file: "apps/web/src/app/api/workers/[id]/respond/route.ts"
  - id: "answer-path-decision"
    type: "test_file"
    path: "apps/web/src/lib/answer-resume.test.ts"
---
# Answered-Question Resume

**Capability statement**: A worker that stopped to ask a person is a healthy
session, not a failure. When its question is answered, the coordination layer
MUST resume that same worker's own session — same task, same worker row, same
worktree, same conversation — whenever the runner still holds it; MUST fall back
to a cold continuation ONLY for a reason it records and shows the owner; and
MUST refuse to resume into a context ceiling or an unhealthy backend credential
rather than discovering either as a death.

`docs/specs/human-in-the-loop-protocol.md` defines who may answer and what an
answer is. This spec defines **what happens to the session afterwards**.

---

## Why this is a distinct question from retry resume

Two earlier audits DROPped session resume. Both judged it for **post-failure
retries**: a session that died is resumed into the state that killed it, at
4–10× the first-turn token cost of a cold start, with the context-exhaustion
class immediately fatal. Those verdicts stand for retries and are not reopened
here.

A parked question is a different class on every axis that decided them:

| | Post-failure retry | Answered question |
|---|---|---|
| Why the session ended | it failed | it asked, correctly |
| What the cold start is missing | a root cause that `failureContext` already carries | every judgement the agent made across the whole session, none of which is recorded anywhere |
| Is the prior transcript safe to inherit | often not (loop-guard, context kill) | yes — nothing went wrong in it |
| Does the worktree survive | no; the runner cleans it on a failed exit | **yes** — the runner keeps the worktree of a `waiting` worker alive on purpose |
| Is there a cheaper substitute | yes (branch + failure excerpt + a reasoning digest) | no; the answer is a reply to a conversation |

The cold path's own inheritance is a description built from the original task,
the milestone labels, the question and the answer, plus `context.baseBranch`.
That branch only resolves if the parked worker had already **pushed** — a
question asked before the first `create_pr` leaves no remote branch, and the
runner silently cuts a fresh worktree from the default branch instead. So on
the common case the cold path inherits neither the reasoning nor the work.

---

## The decision, taken once, at answer time

**Invariants**:
- `POST /api/workers/[id]/respond` MUST classify every accepted answer into
  exactly one path — `resume` or `cold_continuation` — by calling
  `evaluateAnswerPath` (`apps/web/src/lib/answer-resume.ts`), and MUST record
  the resulting `path` and `reasonCode` on the task's `context.answerDelivery`
  before returning. There is no third outcome and no unrecorded outcome.
- `evaluateAnswerPath` MUST be a pure function of server-visible facts. It
  performs no I/O, so the decision is reproducible from the recorded inputs and
  testable without a database.
- The path is `resume` if and only if ALL five gates below hold. Any single
  failing gate yields `cold_continuation` carrying that gate's `reasonCode`.
  Gates are evaluated in a fixed order so a row failing several reports the
  most fundamental one.

| Gate | Condition | `reasonCode` when it fails |
|---|---|---|
| G1 parked | `workerStatus === 'waiting_input'` | `worker_not_parked` |
| G2 transcript held | `now − workerUpdatedAt ≤ RESUME_RUNNER_FRESH_MS` | `runner_not_holding_transcript` |
| G3 confirmable | `supportsInstructionAck === true` | `runner_cannot_confirm_delivery` |
| G4 headroom | `workerTurns ≤ RESUME_MAX_TURNS` | `context_ceiling` |
| G5 credential | preflight returned `ok` or `unknown` | `credential_unhealthy` |

A **revoked** credential is handled before the gates rather than by them: the
answer is refused with `409` and nothing is written (see the credential
preflight section). The gates decide between resuming and going cold; a revoked
credential means neither can run, so there is nothing for them to decide.

**G1 — parked, not merely question-bearing.** `/respond` is deliberately
status-agnostic (it gates on `waitingFor` alone, so an answer is never
swallowed by a worker that also went `error`/`failed`). Resume is not.
`startSession`'s `finally` block in `apps/runner/src/workers.ts` preserves the
worktree only for a worker whose local status is `done` or `waiting`; every
other exit deletes it. A worker carrying `waitingFor` on an `error` row
therefore has no worktree left to resume into, however recent it is.

**G2 — the runner that holds the transcript is the runner that will act.**
Transcripts are node-local (`~/.claude/projects/` for Claude; the stable
per-worker `CODEX_HOME` for Codex) and so is the worktree. `workers.updatedAt`
is the exact signal for "that node still holds this worker": the owning runner
re-syncs every `waiting` worker on its 10s cycle and no other runner ever syncs
it. `RESUME_RUNNER_FRESH_MS` is set at 9× that cycle so a few dropped syncs do
not cost a resume.

This gate is also why the platform needs no runner-affinity queue and pays no
queue latency for it: the answer is not dispatched as claimable work at all. It
is queued on the worker row itself, and only the runner holding that worker
ever reads it. The cost of the design is the opposite one — a resume is
possible only while that node is up, which is precisely what G2 tests.

**G3 — an unconfirmable delivery is indistinguishable from silence.** Only a
runner that speaks the delivery-confirmation protocol
(`workers.supportsInstructionAck`) reports back that the answer reached the
session. Without that acknowledgement there is no way to tell a resumed session
from an answer that vanished, and the platform would have to guess. It refuses
to guess.

**G4 — the context ceiling is decided, not discovered.** A session parked deep
into a long run may resume at or near the model's context limit and die within
a turn or two; that is the first resume audit's strongest finding and it is not
reopened. The server holds no direct measure of a resumed transcript's token
size — `workers.inputTokens` is cumulative across turns and `workers.resultMeta`
is written only at a terminal state, which a parked worker is not — so
`workers.turns` is the declared proxy and `RESUME_MAX_TURNS` the declared
threshold. Above it the platform goes cold **deliberately**, says so, and the
owner sees `context_ceiling` as the reason.

Below the threshold the platform does not rely on luck either: the CLI's own
auto-compaction is the mechanism that keeps a resumed session inside its window
(the agent SDK's context report exposes isAutoCompactEnabled and
autoCompactThreshold; both are SDK-side, not buildd symbols), and the runner
MUST NOT disable it. Requesting a compaction
ourselves at resume time would be strictly worse — the transcript is
materialised before any instruction of ours can run, so a self-issued compact
cannot prevent an over-ceiling load; only not resuming can.

**G5 — a parked session may have sat for hours.** See the credential preflight
section below. G5 covers the recoverable case only — a token that is expired and
could not be refreshed. A revoked credential never reaches the gates.

**Acceptance criteria**:
- AC-AQR-1: GIVEN a worker with `status: 'waiting_input'`, `updatedAt` 5s old,
  `supportsInstructionAck: true`, `turns: 40` and a credential preflight of
  `ok` WHEN `evaluateAnswerPath` runs THEN it returns
  `path: 'resume'`, `reasonCode: 'resume_eligible'`.
- AC-AQR-2: GIVEN the same worker with `status: 'error'` THEN the result is
  `path: 'cold_continuation'`, `reasonCode: 'worker_not_parked'`.
- AC-AQR-3: GIVEN the same worker with `updatedAt` older than
  `RESUME_RUNNER_FRESH_MS` THEN the result is `path: 'cold_continuation'`,
  `reasonCode: 'runner_not_holding_transcript'`.
- AC-AQR-4: GIVEN the same worker with `supportsInstructionAck: false` THEN the
  result is `path: 'cold_continuation'`,
  `reasonCode: 'runner_cannot_confirm_delivery'`.
- AC-AQR-5: GIVEN the same worker with `turns` above `RESUME_MAX_TURNS` THEN
  the result is `path: 'cold_continuation'`, `reasonCode: 'context_ceiling'`.
- AC-AQR-6: GIVEN the same worker with a credential preflight of `unhealthy`
  THEN the result is `path: 'cold_continuation'`,
  `reasonCode: 'credential_unhealthy'`.
- AC-AQR-7: GIVEN a worker failing G1 AND G4 simultaneously THEN the reported
  `reasonCode` is `worker_not_parked` — gate order is fixed, so the reason a
  reader sees is stable rather than dependent on evaluation order.
- AC-AQR-8: GIVEN a credential preflight of `unknown` (no managed credential
  row — the account supplies its own key) THEN G5 passes and the path is
  `resume`; an absent credential MUST NOT be read as a broken one.

**Code surface**:
- `apps/web/src/lib/answer-resume.ts` — `evaluateAnswerPath`,
  `RESUME_RUNNER_FRESH_MS`, `RESUME_MAX_TURNS`, `RESUME_ACK_DEADLINE_MS`,
  `ANSWER_PATH_REASONS`, `buildContinuationTaskValues`
- `apps/web/src/app/api/workers/[id]/respond/route.ts` — the call site
- `apps/runner/src/workers.ts` — the `finally` block that preserves a `waiting`
  worker's worktree, and the 10s sync that keeps `updatedAt` fresh
- `apps/runner/src/worker-sync.ts` — `consumeInstructions` on every waiting
  worker's sync

---

## The resume path

**Invariants**:
- A resumed answer MUST keep the **same task and the same worker row**. No
  `Continue:` task is created, the worker is NOT marked `superseded`, and no
  second worker row is inserted. One continuous record — turns, cost, feed,
  instruction history — is the point: a parent plus a `Continue:` child splits
  every one of those in half and the split is unrecoverable afterwards.
- Because the worker stays the same worker, it later reaches a real terminal
  state (`completed` or `failed`) and is counted honestly by
  `get_failure_analytics` and success-rate-by-role. The `superseded` status and
  its analytics exclusion (`IN_FLIGHT_WORKER_STATUSES` in
  `apps/web/src/lib/failure-analytics.ts`) remain correct and remain in use —
  on the cold path only, where they describe what actually happened.
- The answer MUST be delivered through the existing acknowledged instruction
  queue, not a new invocation: `enqueuePendingInstruction` +
  `appendInstructionHistory` with `deliveryState: 'pending'`
  (`apps/web/src/lib/worker-instructions.ts`), plus the urgent
  `WORKER_COMMAND` push. This is the wiring the runner already drains into
  `sendMessage` → `resumeSession` (`apps/runner/src/recovery.ts`), which routes
  Claude by `worker.sessionId` and Codex by `worker.codexThreadId` and falls
  back to reconstructed context if the SDK resume throws. Owner-visible
  behaviour is identical for both backends.
- The resume invocation MUST NOT combine a session id with a resume id. The CLI
  rejects `--session-id` alongside `--resume` without `--fork-session`, and that
  pair once turned every steering message on a resumed worker into a crash.
  `ClaudeBackend.runStreamed` deletes `sessionId` from the query options
  whenever `resume` is present; the answer path reaches the SDK through exactly
  that code and adds no invocation of its own.
- `waitingFor` MUST be cleared in the same compare-and-swap that claims the
  answer, so a second answerer gets HTTP 409 on the resume path exactly as on
  the cold path.
- The worker's status MUST NOT be changed by `/respond` on this path. It stays
  `waiting_input` until the runner reports `running` for the resumed session.
  Writing `running` from the coordination layer would claim a session start
  that has not happened.
- **A parked or resumed session MUST NOT emit a terminal record.** The
  `workerTerminalRecords` ledger is one row per worker, `workerId` unique with
  `onConflictDoNothing` (`packages/core/terminal-records.ts`), so a row written
  at park time would be the FIRST writer and would silently swallow the resumed
  session's real outcome — the failure mode is a lost measurement, not a
  duplicate. Three properties keep this true and each is load-bearing:
  `isTerminalStatus` in `PATCH /api/workers/[id]` covers only
  `completed`/`failed`/`error`, so `waiting_input` fires nothing; the runner's
  startup reconciliation rewrites only `working`/`stale` (and
  `killedByRestart`, which `loadAllWorkers` sets only for `working`), so a
  restart does not crash-reconcile a parked worker; and `/respond` writes no
  status here. A resumed worker therefore reaches exactly one terminal record,
  at its real end, carrying the whole session's turns and cost rather than the
  pre-answer half.
- The cold path's `superseded` write and the unacknowledged-answer sweep
  produce no terminal record either, because `superseded` is not an
  `isTerminalStatus` and neither write goes through the PATCH route. That is a
  gap in the terminal ledger's own coverage rather than in this contract — a
  superseded worker did not end a session, it was replaced — and it predates
  this capability. Recorded here so a future reader does not read the silence
  as this path's bug.
- The worktree MUST be the one the parked session left, including unpushed
  commits and uncommitted changes. The runner resumes into `worker.worktreePath`
  when it still exists; it survived because the park kept the worker's local
  status at `waiting`, and a waiting worker is never evicted. This is the
  guarantee the cold path cannot make at all: `context.baseBranch` resolves only
  against a branch that was already pushed, and discards uncommitted work in
  every case.

**Acceptance criteria**:
- AC-AQR-9: GIVEN a resume-eligible parked worker WHEN `POST /respond`
  succeeds THEN no row is inserted into `tasks`, the response carries
  `path: 'resume'` and the original task id, and the worker's `status` is
  unchanged.
- AC-AQR-10: GIVEN the same call THEN the worker's `pendingInstructions`
  contains the answer text and a new `instructionHistory` entry carries
  `deliveryState: 'pending'` — never `'delivered'`, which only the runner's
  acknowledgement may write.
- AC-AQR-11: GIVEN the same call THEN the worker's `status` is NOT
  `superseded` and `completedAt` is not set.
- AC-AQR-12: GIVEN a worker whose `waitingFor` is already null WHEN `POST
  /respond` is called THEN HTTP 400 and nothing is queued — the resume path
  offers no second way past the single-answer guard.
- AC-AQR-13: GIVEN two concurrent answers to the same resume-eligible worker
  THEN exactly one receives HTTP 200 and the other HTTP 409, and the answer is
  queued exactly once.

**Code surface**:
- `apps/web/src/app/api/workers/[id]/respond/route.ts`
- `apps/web/src/lib/worker-instructions.ts` — `enqueuePendingInstruction`,
  `appendInstructionHistory`, `markInstructionsDelivered`
- `apps/runner/src/recovery.ts` — `resumeSession` (Layer 1 SDK resume by
  backend-appropriate id, Layer 2 reconstructed context)
- `apps/runner/src/backends/claude-backend.ts` — the `resume`/`sessionId`
  exclusion
- `apps/runner/src/backends/codex-backend.ts` — `resumeThreadId` →
  `codex.resumeThread`

---

## The cold fallback, and why it is loud

**Invariants**:
- The cold path is exactly the behaviour that shipped before this spec: one new
  `pending` task titled `Continue: <original title>`, the parked worker marked
  `superseded`, `context.baseBranch` / `resumeBranch` / `userInput` /
  `previousAttempt` / `iteration + 1` carried across, and the inherited-field
  rules of `docs/specs/human-in-the-loop-protocol.md` unchanged. Falling back
  loses context; it MUST NOT also lose the answer.
- A fallback MUST NOT be silent. Every cold continuation writes
  `context.answerDelivery` on both the parked task and the new task, carrying
  `path`, `reasonCode` and a human-readable `reason`, AND posts one note to the
  task feed naming which path ran and why. "The owner can see which path ran
  and why" is a requirement of this spec, not a nicety: silent degradation
  across runners is the specific failure the retry-resume audits warned about.
- `reasonCode` MUST come from the closed set `ANSWER_PATH_REASONS`. A free-text
  reason is not queryable, and an unqueryable degradation is the same as an
  invisible one.
- A resume that is queued but never acknowledged MUST degrade to a cold
  continuation rather than waiting forever. `cleanupUnresumedAnswers`
  (`apps/web/src/lib/stale-workers.ts`) converts any worker still parked with
  its answer still queued past `RESUME_ACK_DEADLINE_MS` into the cold path with
  `reasonCode: 'resume_not_acknowledged'`, reusing the queued text as the
  answer so nothing is lost. It is reached by `POST /api/tasks/cleanup`, so the
  worst-case latency of that degradation is that route's cadence — each
  runner's 30-minute cleanup timer — not an instant. This is a stated cost, not
  an oversight: the gates make non-delivery rare, and a slow correct fallback
  beats a fast wrong one.
- The sweep MUST be idempotent: once it has written `answerDelivery.path:
  'cold_continuation'` and superseded the worker, a second pass creates no
  second continuation.
- `cleanupUnresumedAnswers` supersedes the worker and inserts the
  `Continue:` task in two separate statements — neon-http has no
  transactions. If the insert throws, the worker MUST be rolled back to
  `waiting_input` with the answer restored on `pendingInstructions`, not left
  `superseded` with the answer gone and no continuation to pick it up (the
  candidate query only looks at `waiting_input`, so a worker stuck
  `superseded` here is never revisited). This mirrors the same compensation
  `respondByContinuation` (`apps/web/src/app/api/workers/[id]/respond/route.ts`)
  already does for the equivalent hazard on the primary answer path.

**Acceptance criteria**:
- AC-AQR-14: GIVEN an answer that falls back for any reason WHEN `POST
  /respond` succeeds THEN the new task's `context.answerDelivery.reasonCode` is
  the failing gate's code and the response carries
  `path: 'cold_continuation'`.
- AC-AQR-15: GIVEN the same call THEN exactly one note is posted to the task
  feed naming the path and the reason.
- AC-AQR-16: GIVEN a worker parked with `answerDelivery.path: 'resume'` and
  `pendingInstructions` still set, older than `RESUME_ACK_DEADLINE_MS`, WHEN
  `cleanupUnresumedAnswers` runs THEN a `Continue:` task is created carrying
  the queued answer, the worker becomes `superseded`, and
  `answerDelivery.reasonCode` is `resume_not_acknowledged`.
- AC-AQR-17: GIVEN the same worker after that sweep has already run WHEN it
  runs again THEN no second task is created.
- AC-AQR-18: GIVEN a worker whose queued answer WAS acknowledged (its
  `instructionHistory` entry reads `delivered` and `pendingInstructions` is
  null) WHEN `cleanupUnresumedAnswers` runs THEN it is left alone.
- AC-AQR-19: GIVEN a worker superseded by the sweep's CAS WHEN the
  compensating `Continue:` task insert throws THEN the worker is rolled back
  to `status: 'waiting_input'` with the answer restored on
  `pendingInstructions`, no continuation task exists, and the OAuth seat is
  not released.

**Code surface**:
- `apps/web/src/lib/answer-resume.ts` — `buildContinuationTaskValues`,
  `describeAnswerPath`
- `apps/web/src/lib/stale-workers.ts` — `cleanupUnresumedAnswers`
- `apps/web/src/app/api/tasks/cleanup/route.ts`

---

## Credential preflight

An owner answered a long-parked worker and it terminated saying it was not
logged in. That is the failure this section exists to prevent.

The mechanism: the runner materialises a per-worker Claude config dir at
session start and **deletes it in the `finally` block** — which runs for a park
too — after deregistering it from the credential broker, so nothing refreshes
it while the question waits. On resume, `startSession` re-materialises it from
the broker, and if the broker has nothing it falls back to the access token
delivered at **claim** time. For a session parked for hours that token is
stale, and the resumed session dies on its first request.

**Invariants**:
- `/respond` MUST evaluate the backend credential BEFORE choosing `resume`, via
  `preflightBackendCredential`
  (`apps/web/src/lib/answer-credential-preflight.ts`). The preflight attempts a
  refresh when the stored token is expired or expires within
  `CREDENTIAL_PREFLIGHT_MARGIN_MS`, and reports the post-refresh state.
- The preflight MUST return exactly one of `ok`, `unhealthy`, `unknown`. A
  missing managed credential row is `unknown`, never `unhealthy` — accounts
  that supply their own key have no row, and reading absence as breakage would
  send every one of them down the cold path forever.
- A **revoked** credential MUST be refused outright — `409` with
  `credentialRevoked: true` — taking neither path and writing nothing, so
  `waitingFor` stays set and the question stays parked. Revoked is terminal
  until a human reconnects the account, and the claim rail already declines to
  inject a revoked credential (`credential-injection.ts`), so a cold
  continuation could not run either. Superseding the worker to create one would
  destroy the transcript and the worktree for nothing; keeping the session
  parked means the re-answer after reconnecting can still take the RESUME path.
  This is the behaviour the sibling change shipped, and resume strengthens
  rather than weakens its case.
- `unhealthy` for any OTHER reason (expired and unrefreshable) MUST NOT silently
  become a cold continuation. That state is recoverable without human action, so
  the answer is recorded durably (a continuation task is created, nothing the
  human typed is lost) AND the owner is told at answer time with a `warning`
  note naming the credential.
- The preflight MUST be advisory-on-error: a refresh that throws, times out or
  returns `locked` yields `unknown`, not `unhealthy`. A transient failure of
  the credential service must not permanently route every answer cold.
- The runner MUST NOT resume a session on a claim-time access token it can see
  is already expired. When `startSession` is invoked with a resume id, the
  broker returns nothing, and the claim-delivered token's expiry is in the past,
  it MUST fail with a named error rather than spawn a session that will die
  unauthenticated. A loud failure is visible to error traces and failure
  analytics; "not logged in" 300 turns deep is not.

**Acceptance criteria**:
- AC-AQR-19: GIVEN a managed Claude credential whose `healthStatus` is
  `revoked` WHEN `preflightBackendCredential` runs THEN it returns `unhealthy`
  with `revoked: true` and attempts no refresh.
- AC-AQR-20: GIVEN a credential whose `tokenExpiresAt` is in the past WHEN the
  preflight runs THEN a refresh is attempted; if it succeeds the result is `ok`
  and if it still reports expired the result is `unhealthy`.
- AC-AQR-21: GIVEN no credential row for the team or workspace THEN the result
  is `unknown` and the answer path is unaffected.
- AC-AQR-22: GIVEN a refresh that throws THEN the result is `unknown`, not
  `unhealthy`.
- AC-AQR-23: GIVEN an `unhealthy` preflight WITHOUT `revoked` (expired and
  unrefreshable) WHEN `POST /respond` succeeds THEN a continuation task exists
  (the answer is not dropped) AND a `warning` note naming the credential is
  posted.
- AC-AQR-24: GIVEN a resume invocation whose broker lookup returns nothing and
  whose claim-delivered token expired WHEN the runner starts the session THEN
  it throws a named credential error before spawning the agent.
- AC-AQR-25: GIVEN a preflight returning `revoked: true` WHEN `POST /respond`
  runs THEN it responds `409` with `credentialRevoked: true` and the backend
  name, no worker row is written, no continuation task is inserted and no feed
  note is posted.

**Code surface**:
- `apps/web/src/lib/answer-credential-preflight.ts` —
  `preflightBackendCredential`, `CREDENTIAL_PREFLIGHT_MARGIN_MS`
- `apps/web/src/lib/claude-credential.ts` — `getClaudeStatus`,
  `refreshClaudeCredential`
- `apps/web/src/lib/codex-credential.ts` — `getCodexStatus`,
  `refreshCodexCredential`
- `apps/runner/src/workers.ts` — the managed-token block in `startSession`
- `apps/runner/src/broker.ts` — `fetchTokenFromBroker`

---

## Why the process is not held open instead

The obvious alternative is never to end the session at all: keep the subprocess
alive with the `AskUserQuestion` tool call unresolved and inject the answer into
the live input stream. The agent SDK supports it and so does the runner — that
is exactly what `inputAsRetry: false` does, delivering the answer as a user
message linked to the pending tool call.

It is not made the default, and the cutover rule is **zero minutes — park
immediately**:

1. **The abort is synchronous with the question.** The runner aborts inside the
   `AskUserQuestion` tool handler, before the question has been persisted long
   enough for any human to see it. There is no window in which a fast answer
   finds a live session, so a "hold live for N minutes" rule would have to
   *introduce* the hold rather than exploit one that exists.
2. **The hold is unbounded by anything the platform controls.** A parked
   question lives for up to 4h (mission) or 24h (standalone) before
   `cleanupStuckWaitingInput` reaps it. Holding a subprocess and an OAuth
   concurrency seat for a day of human latency starves every other task in the
   workspace, and the seat is the scarce resource — `maxConcurrentTasks` is
   measured in single digits.
3. **The cost of parking is now approximately zero.** The whole point of this
   spec is that the parked worker loses nothing: worktree preserved, transcript
   preserved, same worker row, same task, resumed conversation. A live hold
   buys latency, and latency was never the complaint.

`inputAsRetry: false` remains available for local and debug runs, where a human
is already watching and no seat is contended.

---

## Out of scope

- **Post-failure retry resume.** Judged by two prior audits and DROPped on
  economics and on fix quality. Nothing here reopens it; a retry is still a cold
  start with `resumeBranch` and `failureContext`.
- **Runner affinity for claimable work.** This spec deliberately avoids needing
  it by never dispatching the answer as claimable work.
- **The notification that a question was asked**, and its deep link — see
  `docs/specs/human-in-the-loop-protocol.md`.
- **Steering a running worker** (`POST /api/workers/[id]/instruct`,
  `send_agent_message`). The resume path reuses its delivery plumbing but is a
  different interaction: an answer to a question the agent asked, not an
  unsolicited redirect.
- **Making errors after an answer visible** in failure analytics and error
  traces. A sibling contract; whichever path runs here, its failures must be
  seen, and this spec assumes that separately.
- **Token cost of a resumed turn.** Resume re-injects the prior transcript and
  is more expensive per first turn than a cold start. That trade is accepted
  here on correctness grounds and bounded by G4; it is not measured by this
  spec.

---

## Verification gaps

Claims this spec deliberately does NOT make, because the code does not enforce
them.

1. **`workers.turns` is a proxy, not a measurement.** G4 approximates context
   occupancy with turn count. A session with few enormous turns passes the gate
   and can still resume near the ceiling; a session with many tiny turns is sent
   cold for no reason. Closing this needs the runner to report a context-size
   signal for a parked worker, which no current PATCH carries.
2. **`updatedAt` freshness proves a runner is syncing, not that the transcript
   file is present.** A transcript deleted out from under a live runner (disk
   cleanup, a manual `rm`) passes G2. The runner's Layer 2 reconstructed-context
   fallback catches it, so the failure mode is a degraded resume rather than a
   crash — but the owner is told `resume` ran, and Layer 2 is not `resume`.
3. **The fallback sweep rides an undeclared trigger.** `cleanupUnresumedAnswers`
   is reached only through `POST /api/tasks/cleanup`, which no entry in
   `cron-manifest.json` calls; it depends on each runner's 30-minute timer. If
   every runner for a team is down — one of the ways an answer goes
   unacknowledged in the first place — nothing converts it. Inherited from
   `cleanupStuckWaitingInput`, which has the identical exposure.
4. **No cross-channel lock.** An answer delivered through `/respond` on the
   resume path and a concurrent `/instruct` message reach the same session by
   the same queue, in arrival order, with nothing linking the records. This
   mirrors gap 13 of `docs/specs/human-in-the-loop-protocol.md`.
5. **The credential preflight reads state; it does not prove the token works.**
   A credential that is unexpired and `healthy` can still be rejected by the
   provider. Only a live verification call would prove it, and that is a
   per-answer round trip this path does not take.
