import { workerHeartbeatAt, parkedWorkerSeenAt } from '@/lib/worker-patch-diff';
import { NextRequest, NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { db } from '@buildd/core/db';
import { workers, tasks, missionNotes } from '@buildd/core/db/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { callerOwnsWorker } from '@/lib/worker-owner';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { releaseAndNotify } from '@/lib/path-claim-release';
import { wakeTask } from '@/lib/dispatch-authority';
import { dispatchResumedTask } from '@/lib/task-dispatch-delivery';
import {
  appendInstructionHistory,
  enqueuePendingInstruction,
} from '@/lib/worker-instructions';
import { buildWorkerMessage, enqueueWorkerMessage } from '@buildd/core/worker-messages';
import { INTERACTIVE_WORKER_RUNNER } from '@buildd/shared';
import {
  isParked,
  evaluateAnswerPath,
  evaluateInteractiveAnswerPath,
  describeAnswerPath,
  buildAnswerDeliveryRecord,
  explainNotWaiting,
  isReopenableTaskStatus,
  isAnswerableWaitingFor,
  isAnswerQueued,
  recordedAnswerOf,
  type AnswerPathDecision,
} from '@/lib/answer-resume';
import { reopenTaskForAnsweredAttempt, type ReopenForAnswerResult } from '@/lib/answer-attempt';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { clearTeamCache } from '@/lib/team-cache';

// POST /api/workers/[id]/respond - Answer a worker's question.
//
// A worker parked on a question is a HEALTHY session: nothing failed, it
// correctly stopped to ask a human. So this route does NOT unconditionally end
// it. It takes one recorded decision (see lib/answer-resume.ts and
// docs/specs/answered-question-resume.md):
//
//  - RESUME  — the parked worker's own session is resumed with the answer, in
//              the worktree it left (unpushed commits and all), keeping the
//              same task, the same worker row and the same conversation.
//  - INTERACTIVE — the worker is a person's own MCP session (claim_task,
//              runner = 'mcp', parked by ask_human). No runner holds it, so the
//              answer is queued as an `answer` worker message that the
//              session's receive_messages returns, and the worker goes back to
//              running. Same task, same worker, no continuation.
//  - COLD    — the session is genuinely gone: supersede the worker and reopen
//              its OWN task for a new attempt carrying the answer (never a new
//              task: same task id, mission slot and dependency node). Never
//              silent — the reason is recorded and shown.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const seen: { teamId?: string | null } = {};
  const res = await respond(req, ctx, seen);
  // An answer changes the team's questions waiting (lib/team-cache.ts): its
  // cached list goes now, whichever path below took it.
  if (res.ok) await clearTeamCache(seen.teamId, 'questions');
  return res;
}

async function respond(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  seen: { teamId?: string | null },
) {
  const { id } = await params;
  // workers.id is a uuid column: a non-UUID can never name a worker, and
  // querying with one throws 22P02, which escaped as a 500.
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  // Dual auth: session OR API key
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey, req);

  if (!user && !account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Load worker with its task
  const worker = await db.query.workers.findFirst({
    where: sqlWhere(eq(workers.id, id)),
    with: { workspace: true, task: true, account: true },
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }
  seen.teamId = worker.workspace?.teamId ?? null;

  // Verify access: a bearer caller must be the principal that claimed the worker
  // (lib/worker-owner.ts), or an admin-level token of the worker's own team —
  // the same authority as /instruct, so an interactive operator session (the
  // MCP answer_question action) can unblock a parked worker it did not claim.
  // The dashboard session path checks workspace membership.
  if (account) {
    const teamAdmin = hasTokenRouteAdminAccess(account, req, 'workers:admin')
      && !!account.teamId
      && account.teamId === (worker as any).workspace?.teamId;
    if (!teamAdmin && !callerOwnsWorker(account, worker)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  } else if (user) {
    const access = await verifyWorkspaceAccess(user.id, worker.workspaceId);
    if (!access) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }
  }

  // Something must still be answerable. A question stays answerable on an
  // errored worker (inputAsRetry leaves it open); a permission prompt only while
  // its session is parked on it — the same rule every needs-input card renders
  // by, so a card that is shown can be answered. Reaching here otherwise means
  // the caller's card is stale: say what happened and where to go, not which
  // gate fired, and write nothing.
  if (!isAnswerableWaitingFor(worker.status, worker.waitingFor as { type?: string } | null)) {
    const explained = explainNotWaiting({
      workerStatus: worker.status,
      continuationTaskId: (worker as { continuationTaskId?: string | null }).continuationTaskId ?? null,
      answerQueued: isAnswerQueued(worker),
      interactive: (worker as { runner?: string | null }).runner === INTERACTIVE_WORKER_RUNNER,
    });
    return NextResponse.json(
      {
        error: explained.message,
        reasonCode: explained.reasonCode,
        nextAction: explained.nextAction,
        // A duplicate tap is told what was recorded, so the card can show the
        // answer instead of an error.
        ...(explained.reasonCode === 'already_answered' ? { recordedAnswer: await readRecordedAnswer(worker) } : {}),
        workerStatus: worker.status,
        taskId: worker.taskId ?? null,
      },
      { status: 400 }
    );
  }

  const body = await req.json();
  const { message } = body;

  if (!message || typeof message !== 'string') {
    return NextResponse.json(
      { error: 'Message is required' },
      { status: 400 }
    );
  }

  const task = (worker as any).task;
  const isSensitive = (worker as any).workspace?.dataClass === 'sensitive';
  // Sensitive-dataClass workspaces strip milestone labels, leaving { type, ts }.
  const milestones = (worker.milestones as unknown as Array<{ type?: string; label?: string; timestamp: number }>) || [];
  const waitingFor = worker.waitingFor as { type?: string; prompt: string; sessionSeenAt?: string };
  const question = waitingFor.prompt;

  // ── The decision ──────────────────────────────────────────────────────────
  //
  // An interactive session is decided first: it runs on the person's own
  // login. A GONE interactive session falls through to the runner paths.
  const [liveUpdatedAt, liveSessionSeenAt] = await Promise.all([
    workerHeartbeatAt(id, worker.updatedAt),
    parkedWorkerSeenAt(id, waitingFor.sessionSeenAt ?? null),
  ]);
  const interactiveDecision = evaluateInteractiveAnswerPath({
    workerRunner: (worker as { runner?: string | null }).runner ?? null,
    workerStatus: worker.status,
    workerUpdatedAt: liveUpdatedAt,
    // The parked session's poll heartbeat (await_answer / receive_messages).
    sessionSeenAt: liveSessionSeenAt,
  });
  if (interactiveDecision?.path === 'interactive') {
    return respondToInteractiveSession({
      workerId: id,
      worker,
      task,
      message,
      question,
      isSensitive,
      decision: interactiveDecision,
      deliveryRecord: buildAnswerDeliveryRecord({
        decision: interactiveDecision,
        workerId: worker.id,
        question: isSensitive ? null : question,
      }),
    });
  }
  const decision = evaluateAnswerPath({
    workerStatus: worker.status,
    workerUpdatedAt: liveUpdatedAt,
    workerTurns: worker.turns,
    supportsInstructionAck: (worker as { supportsInstructionAck?: boolean }).supportsInstructionAck === true,
    // No stored subscription login exists to check: the runner's own login is its business.
    credentialPreflight: 'unknown',
    waitingForType: waitingFor.type ?? null,
    parkedUntil: (worker as { parkedUntil?: Date | null }).parkedUntil ?? null,
    workerRunner: (worker as { runner?: string | null }).runner ?? null,
    sessionSeenAt: liveSessionSeenAt,
  });

  const deliveryRecord = buildAnswerDeliveryRecord({
    decision,
    workerId: worker.id,
    question: isSensitive ? null : question,
  });

  if (decision.path === 'resume') {
    return respondByResume({
      workerId: id,
      worker,
      task,
      message,
      isSensitive,
      decision,
      deliveryRecord,
    });
  }

  return respondByContinuation({
    workerId: id,
    worker,
    task,
    message,
    question,
    milestones,
    decision,
    deliveryRecord,
  });
}

type DeliveryRecord = ReturnType<typeof buildAnswerDeliveryRecord>;

/**
 * Resume path: the answer is queued on the SAME worker row, which the runner
 * holding this session drains on its next sync and injects into a resumed
 * session (`sendMessage` → `resumeSession`, Claude by session id / Codex by
 * thread id, in the preserved worktree).
 *
 * No `Continue:` task, no `superseded`, no second worker row: one continuous
 * record of turns, cost and feed, which a parent-plus-child split destroys
 * irrecoverably.
 */
async function respondByResume(args: {
  workerId: string;
  worker: any;
  task: any;
  message: string;
  isSensitive: boolean;
  decision: AnswerPathDecision;
  deliveryRecord: DeliveryRecord;
}) {
  const { workerId, worker, task, message, isSensitive, decision, deliveryRecord } = args;

  // One atomic write claims the answer AND queues it. Gating on the question
  // still being open is what stops two humans (or one double-submit) from
  // answering twice; doing both in one UPDATE means a loser leaves nothing
  // behind and there is no window in which the question is claimed but the
  // answer is not yet queued.
  //
  // `status` is deliberately untouched. It stays `waiting_input` until the
  // runner reports `running` for the resumed session — writing `running` here
  // would claim a session start that has not happened.
  const [claimed] = await db
    .update(workers)
    .set({
      waitingFor: null,
      pendingInstructions: enqueuePendingInstruction(worker.pendingInstructions, message),
      instructionHistory: appendInstructionHistory(worker.instructionHistory, {
        message,
        isSensitive,
        // Only the runner's acknowledgement may write 'delivered'. An
        // unacknowledged answer is what `cleanupUnresumedAnswers` later
        // degrades to a cold continuation.
        deliveryState: 'pending',
      }),
      currentAction: 'Answer received — resuming session',
      updatedAt: new Date(),
    })
    .where(and(eq(workers.id, workerId), isNotNull(workers.waitingFor)))
    .returning();

  if (!claimed) return alreadyAnsweredReply(workerId);

  if (task?.id) {
    await recordAnswerDelivery(task.id, task.context, deliveryRecord);
  }

  // Urgent push so a subscribed runner acts now rather than on its next 10s
  // sync. Both transports are used here — normally forbidden, because an older
  // runner would inject the pushed copy AND the queued one — but gate G3 has
  // already established this runner speaks the acknowledgement protocol, which
  // is exactly the runner that de-duplicates. The queue is the durable half: a
  // push that reaches nobody is still recoverable on the next sync.
  await triggerEvent(
    channels.worker(workerId),
    events.WORKER_COMMAND,
    { action: 'message', text: message, timestamp: Date.now() },
  ).catch(() => { /* durable queue is the contract; the push is an accelerator */ });

  // A worker the cloud runner parked has no container to drain the queue:
  // wake one (task.resume) that re-attaches to this same worker. Best effort;
  // an answer nobody acknowledges is degraded by cleanupUnresumedAnswers.
  let resumeDispatched: boolean | undefined;
  if (isParked(worker.parkedUntil)) {
    resumeDispatched = await dispatchResumedTask(task ?? { id: worker.taskId, title: '', description: null, workspaceId: worker.workspaceId }, worker.workspace ?? { id: worker.workspaceId }, workerId)
      .catch((err) => {
        console.error(`[Worker ${workerId}] task.resume dispatch failed:`, err);
        return false;
      });
  }

  await postAnswerNote({
    task,
    workerId,
    type: 'update',
    title: 'Answer delivered to the running session',
    body: describeAnswerPath(decision),
  });

  return NextResponse.json({
    ...(resumeDispatched !== undefined ? { resumeDispatched } : {}),
    path: 'resume',
    reasonCode: decision.reasonCode,
    // Same task — the resumed worker continues under it. Callers navigate here.
    taskId: task?.id ?? null,
    workerId,
    message: describeAnswerPath(decision),
  });
}

/**
 * Interactive path: the worker is a person's own MCP session, parked by
 * ask_human. The answer is queued as an `answer` worker message on the
 * worker's own task — the queue `receive_messages` (and update_progress)
 * serve to an interactive worker and settle by id — and the worker goes back
 * to `running` at once: unlike a runner resume, no session start is pending,
 * the session is alive and simply has not read its inbox yet.
 *
 * The instruction-history entry shares the message's id, so the session's ack
 * (`workerMessagesDelivered`) marks it read, and until then a duplicate tap is
 * recognised as already answered (`isAnswerQueued`).
 */
async function respondToInteractiveSession(args: {
  workerId: string;
  worker: any;
  task: any;
  message: string;
  question: string;
  isSensitive: boolean;
  decision: AnswerPathDecision;
  deliveryRecord: DeliveryRecord;
}) {
  const { workerId, worker, task, message, question, isSensitive, decision, deliveryRecord } = args;
  const taskId: string | null = task?.id ?? worker.taskId ?? null;
  if (!taskId) {
    return NextResponse.json({ error: 'Failed to record response' }, { status: 500 });
  }

  const answerMessage = buildWorkerMessage({
    type: 'answer',
    fromTaskId: taskId,
    toTaskId: taskId,
    fromWorkerId: null,
    body: {
      // A human answering the session's own question, not another agent.
      source: 'human',
      text: message,
      ...(!isSensitive && question ? { question } : {}),
      workerId,
    },
  });

  // Claim the answer first, atomically, exactly like the other two paths: the
  // CAS on waitingFor is what stops a double tap from answering twice.
  const [claimed] = await db
    .update(workers)
    .set({
      status: 'running',
      waitingFor: null,
      instructionHistory: appendInstructionHistory(worker.instructionHistory, {
        id: answerMessage.id,
        message,
        isSensitive,
        deliveryState: 'pending',
      }),
      currentAction: 'Answer received — waiting for the session to read it',
      updatedAt: new Date(),
    })
    .where(and(eq(workers.id, workerId), isNotNull(workers.waitingFor)))
    .returning();

  if (!claimed) return alreadyAnsweredReply(workerId);

  let queued = false;
  try {
    queued = await enqueueWorkerMessage(taskId, answerMessage);
  } catch (err) {
    console.error(`[Worker ${workerId}] Interactive answer enqueue failed:`, err);
  }
  if (!queued) {
    // No transactions on neon-http: put the question back so the answer can be
    // given again, rather than leave a running worker with nothing to read.
    await db
      .update(workers)
      .set({
        status: worker.status,
        waitingFor: worker.waitingFor,
        instructionHistory: worker.instructionHistory ?? [],
        currentAction: worker.currentAction ?? null,
        updatedAt: new Date(),
      })
      .where(eq(workers.id, workerId));
    return NextResponse.json({ error: 'Failed to record response' }, { status: 500 });
  }

  if (task?.id) {
    // Merged into the LIVE context in SQL: enqueueWorkerMessage just appended
    // the answer to that same column, and spreading the context read before
    // it (recordAnswerDelivery) would delete the answer from the queue. The
    // record names the message so await_answer can find the answer by it even
    // after the capped queue has evicted it.
    // waitCapId: the ask the wait capability names (answer/capability), so the
    // shell waiter can tell the answer to its own ask from a later one's.
    const waitCapId = (worker.waitingFor as { waitCapId?: unknown } | null)?.waitCapId;
    const record = {
      ...deliveryRecord,
      messageId: answerMessage.id,
      ...(typeof waitCapId === 'string' && waitCapId ? { waitCapId } : {}),
    };
    await db
      .update(tasks)
      .set({
        context: sql`COALESCE(${tasks.context}, '{}'::jsonb) || jsonb_build_object('answerDelivery', ${JSON.stringify(record)}::jsonb)` as any,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id))
      .catch((err: unknown) => {
        console.error(`[Task ${task.id}] Failed to record answerDelivery:`, err);
      });
  }

  // The status changed outside PATCH /api/workers/[id], which normally emits
  // it: tell every open view the question is gone and the worker is running.
  const runningEvent = {
    workerId,
    taskId,
    status: 'running',
    updatedAt: claimed.updatedAt ?? new Date().toISOString(),
  };
  await Promise.all([
    triggerEvent(channels.workerActivity(workerId), events.WORKER_PROGRESS, runningEvent),
    triggerEvent(channels.task(taskId), events.WORKER_PROGRESS, runningEvent),
  ]).catch(() => { /* a missed push only leaves a stale card, which /respond explains */ });

  await postAnswerNote({
    task,
    workerId,
    type: 'update',
    title: 'Answer sent back to the interactive session',
    body: describeAnswerPath(decision),
  });

  return NextResponse.json({
    path: 'interactive',
    reasonCode: decision.reasonCode,
    taskId,
    workerId,
    messageId: answerMessage.id,
    message: describeAnswerPath(decision),
  });
}

/**
 * Cold path: the session cannot be resumed, so the answer goes to a new attempt
 * of the SAME task. The worker is superseded and its task reopened `pending`
 * with the answer in `context.answeredQuestions` (lib/answer-attempt.ts); the
 * next claim mints a new worker row under the same task id. No task is
 * inserted, so a mission keeps its task count and the task keeps its place in
 * the dependency graph: a dependent stays blocked until an attempt completes it.
 */
async function respondByContinuation(args: {
  workerId: string;
  worker: any;
  task: any;
  message: string;
  question: string;
  milestones: Array<{ type?: string; label?: string; timestamp: number }>;
  decision: AnswerPathDecision;
  deliveryRecord: DeliveryRecord;
  credentialDetail?: string;
}) {
  const { workerId, worker, task, message, question, milestones, decision, deliveryRecord } = args;
  const taskId: string | null = task?.id ?? worker.taskId ?? null;

  // A task that finished or that a person cancelled is never reopened by an
  // answer. Refused before anything is written, so the question stays parked.
  if (!taskId) return notReopenedReply({ reopened: false, reason: 'task_missing' }, workerId, null);
  if (task?.status && !isReopenableTaskStatus(task.status)) {
    return notReopenedReply({ reopened: false, reason: 'task_closed' }, workerId, taskId);
  }

  // Claim the answer FIRST, atomically. `worker.waitingFor` was read outside the
  // write, so two humans answering the same question (or one double-submitting)
  // both passed the guard above. Gating the state flip on the question still
  // being open means only the winner reopens the task, and a loser writes
  // nothing.
  //
  // Status is 'superseded', not 'completed': this attempt did not finish its
  // task, a new attempt of the same task replaces it. 'completed' would count an
  // answered question as a clean success in get_failure_analytics /
  // success-rate-by-role, 'failed' as a failure. 'superseded' is excluded from
  // both buckets (IN_FLIGHT_WORKER_STATUSES in lib/failure-analytics.ts) and is
  // in TERMINAL_WORKER_STATUSES (workers/[id]/route.ts), so a later PATCH from
  // the runner for this same worker is rejected instead of resurrecting it. The
  // new attempt is its own worker row and is counted at its own real end.
  //
  // Known residual race, deliberately not closed here: this write and an
  // in-flight runner PATCH for the same worker use independent, uncoordinated
  // CAS predicates (this one gates on waitingFor being set; the PATCH route's
  // terminal-transition reservation gates on status). If the runner's PATCH has
  // already read the pre-answer row and is mid-flight when this commits, its
  // own later write can still land after this one and overwrite `status`. A
  // worker read AFTER this commits is correctly rejected (terminal-status
  // guard), so the window is narrow — but fully closing it needs a shared
  // reservation primitive between the two routes, not a stronger predicate
  // here: gating this claim on worker status (rather than only waitingFor)
  // would break the deliberate, tested contract that an AskUserQuestion abort
  // can legitimately leave status='error'/'failed' with waitingFor still set.
  const [claimed] = await db
    .update(workers)
    .set({
      status: 'superseded',
      waitingFor: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(workers.id, workerId), isNotNull(workers.waitingFor)))
    .returning();

  if (!claimed) return alreadyAnsweredReply(workerId);

  // No transactions on neon-http: if the task cannot be reopened, put the
  // question back exactly as it was, so the answer can simply be given again
  // instead of leaving a superseded worker whose answer reached no attempt.
  const restoreQuestion = () => db
    .update(workers)
    .set({
      status: worker.status,
      waitingFor: worker.waitingFor,
      completedAt: worker.completedAt ?? null,
      updatedAt: new Date(),
    })
    .where(eq(workers.id, workerId));

  let reopened: ReopenForAnswerResult;
  try {
    reopened = await reopenTaskForAnsweredAttempt({
      taskId,
      worker: { id: worker.id, branch: worker.branch ?? null, lastCommitSha: worker.lastCommitSha ?? null, completedAt: claimed.completedAt ?? null },
      milestones,
      question,
      answer: message,
      delivery: deliveryRecord,
      source: 'respond',
    });
  } catch (err) {
    console.error(`[Worker ${workerId}] Reopening the task for a new attempt failed, restoring question:`, err);
    await restoreQuestion();
    return NextResponse.json({ error: 'Failed to record response' }, { status: 500 });
  }
  if (!reopened.reopened) {
    await restoreQuestion();
    return notReopenedReply(reopened, workerId, taskId);
  }

  // The superseded attempt's path claims go, as on every requeue: the new
  // attempt declares its own. Left in place they would strand every other task
  // overlapping those paths until this task finishes.
  await releaseAndNotify(taskId, 'abandoned');

  // Every other open view of this worker — a phone left on the task page, the
  // home and mission cards — is still showing the question, and nothing else
  // tells it the worker is gone: supersession happens here, outside the PATCH
  // route that normally emits status changes. A status change on
  // `worker:progress` is exactly what those views refresh on immediately.
  const supersededEvent = {
    workerId,
    taskId,
    status: 'superseded',
    updatedAt: claimed.updatedAt ?? new Date().toISOString(),
  };
  await Promise.all([
    triggerEvent(channels.workerActivity(workerId), events.WORKER_PROGRESS, supersededEvent),
    triggerEvent(channels.task(taskId), events.WORKER_PROGRESS, supersededEvent),
  ]).catch(() => { /* a missed push only leaves a stale card, which /respond now explains */ });

  // Wake runners for the reopened task, as every requeue does. Polling runners
  // would find it eventually; a webhook-only workspace never would. Held and
  // local-executor missions are not filtered here: the claim route's gate
  // refuses them. wakeTask never throws.
  await wakeTask(taskId, 'task.requeued');

  // An unhealthy credential still reopens the task (the answer is durable), but
  // that is not progress: the new attempt cannot start until it is reconnected,
  // and both the note and the reply say so.
  await postAnswerNote({
    task: task ?? { id: taskId, missionId: null },
    workerId,
    type: args.credentialDetail ? 'warning' : 'update',
    title: args.credentialDetail
      ? 'Answer recorded, but the agent credential needs attention'
      : 'Answer handed to a new attempt of this task',
    body: args.credentialDetail
      ? `${describeAnswerPath(decision)} Specifically, ${args.credentialDetail}. `
        + 'The new attempt cannot start until the credential is reconnected.'
      : describeAnswerPath(decision),
  });

  return NextResponse.json({
    path: 'cold_continuation',
    reasonCode: decision.reasonCode,
    // The same task: the new attempt runs under it. Callers stay on this task.
    taskId,
    workerId,
    newAttempt: true,
    ...(args.credentialDetail ? { blockedOn: 'credential' } : {}),
    message: describeAnswerPath(decision),
  });
}

/** Why an answer that would go cold could not reopen its task. Nothing stays written. */
function notReopenedReply(r: Extract<ReopenForAnswerResult, { reopened: false }>, workerId: string, taskId: string | null) {
  const error = r.reason === 'task_closed'
    ? 'This task has already finished or was cancelled, so the answer cannot start a new attempt of it.'
    : r.reason === 'task_missing'
      ? 'This question has no task to continue.'
      : 'The task could not be reopened for a new attempt right now (it changed while you answered). Refresh and try again.';
  return NextResponse.json({ error, reasonCode: r.reason, workerId, taskId }, { status: 409 });
}

/**
 * The reply to an answer that lost the race to another one (a double tap, two
 * people). It says what was recorded, re-read after the winner's write, so the
 * card shows the answer rather than an error.
 */
async function alreadyAnsweredReply(workerId: string) {
  const fresh = await db.query.workers.findFirst({ where: sqlWhere(eq(workers.id, workerId)) }).catch(() => null);
  return NextResponse.json(
    {
      error: 'Question was already answered',
      reasonCode: 'already_answered',
      recordedAnswer: fresh ? await readRecordedAnswer(fresh) : null,
    },
    { status: 409 },
  );
}

/** What an answered question was answered with. Best effort: a failed read only drops the text. */
async function readRecordedAnswer(worker: { id?: string; taskId?: string | null; status: string | null; instructionHistory?: unknown; continuationTaskId?: string | null }): Promise<string | null> {
  try {
    let continuationContext: unknown = null;
    let taskContext: unknown = null;
    if (worker.status === 'superseded') {
      // A legacy record's answer is its continuation task's brief; a new
      // attempt's is on the worker's own task.
      const from = worker.continuationTaskId ?? worker.taskId ?? null;
      const row = from
        ? await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, from)), columns: { context: true } })
        : null;
      if (worker.continuationTaskId) continuationContext = row?.context ?? null;
      else taskContext = row?.context ?? null;
    }
    return recordedAnswerOf({ workerStatus: worker.status, instructionHistory: worker.instructionHistory, continuationContext, taskContext, workerId: worker.id ?? null });
  } catch {
    return null;
  }
}

/** Stamp the decision on the answered task so the path taken is queryable. */
async function recordAnswerDelivery(
  taskId: string,
  currentContext: unknown,
  record: DeliveryRecord,
) {
  const context = (currentContext as Record<string, unknown>) || {};
  await db
    .update(tasks)
    .set({ context: { ...context, answerDelivery: record }, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
    .catch((err) => {
      // The path already ran; losing its record is bad but not worth failing
      // the answer over. Log loudly so it is not invisible twice.
      console.error(`[Task ${taskId}] Failed to record answerDelivery:`, err);
    });
}

/** One feed note naming which path ran and, when it degraded, why. */
async function postAnswerNote(args: {
  task: any;
  workerId: string;
  type: 'update' | 'warning';
  title: string;
  body: string;
}) {
  if (!args.task?.id) return;
  await db
    .insert(missionNotes)
    .values({
      missionId: args.task.missionId ?? null,
      taskId: args.task.id,
      workerId: args.workerId,
      authorType: 'system',
      type: args.type,
      title: args.title,
      body: args.body,
      status: 'open',
    })
    .catch((err) => {
      console.error(`[Task ${args.task.id}] Failed to post answer-path note:`, err);
    });
}
