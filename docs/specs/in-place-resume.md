---
title: In-Place Resume
status: active
owner: max
last_verified: 2026-11-23
summary: A tier or model change, or a requeue, of a running task MUST pause its agent and resume the same session when it can be resumed, and MUST otherwise take a new attempt for a recorded, owner-visible reason.
domain: runners
surfaces: [apps/web/src/lib/in-place-resume.ts, apps/web/src/lib/in-place-resume-policy.ts, apps/web/src/app/api/tasks/[id]/route.ts, apps/runner/src/session-model-switch.ts]
related: [answered-question-resume, worker-reclamation, runner-liveness, mission-task-lifecycle]
keywords: [resume in place, resumed in place, new attempt, requeue, status pending, tier change, model change, model switch, inPlaceResume, resumeHistory, pendingModelChange, sessionModel, takesSessionModel, pause, park, Runner offline requeued by owner]
verified_by: [apps/web/src/lib/in-place-resume-policy.test.ts, apps/web/src/lib/in-place-resume.test.ts, apps/web/src/app/api/tasks/[id]/route.test.ts, apps/runner/__tests__/unit/session-model-switch.test.ts, packages/core/__tests__/mcp-tools-update-task-model.test.ts]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "plan-in-place-resume"
    type: "symbol"
    name: "planInPlaceResume"
    path: "apps/web/src/lib/in-place-resume-policy.ts"
  - id: "resume-after-pause"
    type: "symbol"
    name: "resumeAfterPause"
    path: "apps/web/src/lib/in-place-resume.ts"
  - id: "settle-on-reactivation"
    type: "symbol"
    name: "settleOnReactivation"
    path: "apps/web/src/lib/in-place-resume.ts"
  - id: "sweep-in-place-resumes"
    type: "symbol"
    name: "sweepInPlaceResumes"
    path: "apps/web/src/lib/in-place-resume.ts"
  - id: "adopt-server-session-model"
    type: "symbol"
    name: "adoptServerSessionModel"
    path: "apps/runner/src/session-model-switch.ts"
  - id: "atomic-guards-on-real-rows"
    type: "test_file"
    path: "apps/web/tests/db/in-place-resume.test.ts"
---
# In-Place Resume

**Capability statement**: A run's reading and reasoning live in its session.
An owner who changes a running task's tier or model, or restarts it, MUST NOT
lose that session when it can be resumed: the agent is paused at a safe point,
the change is applied, and the SAME session continues, on the same worker row,
in the same worktree. A model switch is allowed: the transcript survives it,
the prompt cache does not. Where no session can be resumed the task takes a new
attempt, and both the tool result and the task's activity say which happened
and why.

`answered-question-resume` defines what happens to a session when its question
is answered. This spec defines what happens to it when the owner changes or
restarts the task.

## Triggers

| Request | Live agent | What happens |
|---|---|---|
| `PATCH /api/tasks/[id]` with `tier` or `model` (`update_task`) | resumable | Resume in place on the new model. |
| same | not resumable | The running attempt keeps its model; the change applies from the next attempt. The agent is not ended. |
| same | none | The change applies at the next claim. |
| `PATCH /api/tasks/[id]` with `status: pending` (`update_task`, the requeue) | resumable | Resume in place. The task keeps its status, its claim and its worker. |
| same | not resumable, or none | New attempt: live workers are ended, path claims released, the task requeued (the behaviour before this spec). |

A request that changes the model to the one the run is already on does nothing
to the agent.

## Invariants

1. **One decision, fixed order.** `planInPlaceResume` decides from the live
   worker alone and reports a stable reason: no live worker, an interactive
   session, a session that has not started, a runner that stopped reporting
   with nothing parked, a runner that cannot confirm delivery, a permission
   prompt. A model change additionally needs a model to continue on (a pin, or
   a tier the registry resolves) and a Claude session.
2. **Pause, then resume, with nobody pressing anything.** A running agent is
   paused through the ordinary pause request. When it parks
   (`waiting_input`, `waitingFor.type: 'pause'`), the worker PATCH that
   reports the park queues one resume message on that worker. An agent already
   parked (a pause, a question, a cloud park bundle) is resumed at once. A
   pause a person asked for carries no intent and stays paused.
3. **The model travels on the runner's own resume call.** The runner resumes
   with `status: running, reactivate: true, takesSessionModel: true`; the reply
   carries `sessionModel`, and the runner adopts it before resuming the session
   by its id (Claude) or thread id (Codex). The same call settles the record.
   This also covers a runner that went offline and came back, and a parked
   worker whose answer arrived: any resume of the session picks up a change
   that was made while it was away.
4. **One live worker per task.** Nothing here creates a worker or frees the
   task for another claim. The resume message is queued by a compare-and-swap
   on the worker row (still `waiting_input`, queue unchanged), and the step
   from `pausing` to `resuming` is one atomic `UPDATE ... WHERE` on the task,
   so the worker PATCH and the sweep cannot both resume it. No interactive
   transaction is used.
5. **A resume that does not happen degrades, visibly.** The queued message
   leaves the same `answerDelivery` record an answer does, so a resume the
   runner never acknowledges becomes a new attempt (`cleanupUnresumedAnswers`).
   A pause not reached by `IN_PLACE_PAUSE_DEADLINE_MS` is settled by the
   waiting-input sweep: a model change waits for the next attempt, a requeue
   takes the new attempt. A claim that finds an unsettled intent records it as
   a new attempt.
6. **Every outcome is recorded once.** `tasks.context.resumeHistory` keeps the
   newest outcomes: `resumed_in_place` (with the old and new model) or
   `new_attempt` (with a reason from the closed set `NEW_ATTEMPT_REASONS`).
   Each is also a system note on the task. The task page shows the line under
   the attempt it happened to; `update_task` returns it as `modelChange` and
   `requeue`.
7. **Never a claim that did not happen.** A runner that does not take a model
   from buildd (an older build, or `BUILDD_HONOR_TASK_MODEL=0`) is recorded as
   resumed in place on its old model, and the model change as waiting for a
   new attempt.

## Not covered

- A Codex session keeps the model it started with: a tier or model change on a
  Codex task applies from the next attempt. A requeue still resumes it in place.
- A worker the server already failed because its runner stayed offline past the
  liveness cutoff is not revived; that task takes a new attempt
  (`worker-reclamation`).
- `POST /api/tasks/[id]/reassign` is a deliberate new attempt and is unchanged.

## Code surface

- `apps/web/src/lib/in-place-resume-policy.ts`: the plan, the wording, the history.
- `apps/web/src/lib/in-place-resume.ts`: the writes, the worker PATCH hooks, the sweep.
- `apps/web/src/app/api/tasks/[id]/route.ts`: the two triggers.
- `apps/web/src/app/api/workers/[id]/route.ts`: resume after the park, `sessionModel` on the resume call.
- `apps/web/src/app/api/workers/claim/route.ts`: an unsettled intent becomes a new attempt.
- `apps/web/src/app/api/cron/waiting-input-sweep/route.ts`: the sweep.
- `apps/runner/src/session-model-switch.ts`, `apps/runner/src/workers.ts` (`sendMessage`): adopting the model.
- `apps/web/src/app/app/(protected)/tasks/[id]/page.tsx`: the task page line.
