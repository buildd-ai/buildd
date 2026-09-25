import { NextRequest, NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { db } from '@buildd/core/db';
import { workers, tasks, missionNotes } from '@buildd/core/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { releaseAndNotify } from '@/lib/path-claim-release';
import {
  appendInstructionHistory,
  enqueuePendingInstruction,
} from '@/lib/worker-instructions';
import {
  evaluateAnswerPath,
  describeAnswerPath,
  buildAnswerDeliveryRecord,
  buildContinuationTaskValues,
  type AnswerPathDecision,
} from '@/lib/answer-resume';
import { preflightBackendCredential } from '@/lib/answer-credential-preflight';

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
//  - COLD    — the pre-existing behaviour: supersede the worker and insert a
//              `Continue:` task. Correct when the session is genuinely gone,
//              and never silent — the reason is recorded and shown.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
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
  const account = await authenticateApiKey(apiKey);

  if (!user && !account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Load worker with its task
  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    with: { workspace: true, task: true, account: true },
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  // Verify access: API key checks account ownership, session checks workspace membership
  if (account) {
    if (worker.accountId !== account.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  } else if (user) {
    const access = await verifyWorkspaceAccess(user.id, worker.workspaceId);
    if (!access) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }
  }

  // Worker must have waitingFor set (status failed with needs_input or waiting_input)
  if (!worker.waitingFor) {
    return NextResponse.json(
      { error: 'Worker is not waiting for input' },
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
  const milestones = (worker.milestones as Array<{ type?: string; label?: string; timestamp: number }>) || [];
  const question = (worker.waitingFor as { prompt: string }).prompt;

  // ── The decision ──────────────────────────────────────────────────────────
  //
  // Credential health is checked BEFORE choosing a path, not after resuming
  // into an auth failure: a parked question can sit for hours, and the runner
  // released this worker's credential file when it parked.
  const backend = task?.backend === 'codex' ? 'codex' : 'claude';
  const preflight = await preflightBackendCredential({
    // Both `workspaces` and `accounts` carry the owning teamId and they agree;
    // read whichever relation the row actually loaded.
    teamId: (worker as any).workspace?.teamId ?? (worker as any).account?.teamId ?? null,
    workspaceId: worker.workspaceId,
    backend,
  });

  // A REVOKED credential is refused outright rather than routed down either
  // path — the behaviour #2528 shipped, and it is the right one for this case
  // for a reason that sharpens under resume: the continuation could not run
  // either (the claim rail declines to inject a revoked credential), while
  // superseding the worker would destroy the transcript and the worktree that
  // make a resume possible at all. Refusing keeps the question parked, so the
  // re-answer after reconnecting can still take the RESUME path. `waitingFor`
  // is untouched and nothing is written.
  //
  // An EXPIRED-and-unrefreshable credential is different and falls through to
  // gate G5 below: it is recoverable without human action, so the answer is
  // recorded durably as a cold continuation instead of being bounced.
  if (preflight.revoked) {
    return NextResponse.json({
      error: `Backend credential (${backend}) is revoked — reconnect it in Settings → Agent Backends before continuing.`
        + (preflight.lastFailureMessage ? ` Last error: ${preflight.lastFailureMessage.slice(0, 200)}` : ''),
      credentialRevoked: true,
      backend,
    }, { status: 409 });
  }

  const decision = evaluateAnswerPath({
    workerStatus: worker.status,
    workerUpdatedAt: worker.updatedAt,
    workerTurns: worker.turns,
    supportsInstructionAck: (worker as { supportsInstructionAck?: boolean }).supportsInstructionAck === true,
    credentialPreflight: preflight.state,
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
    credentialDetail: preflight.state === 'unhealthy' ? preflight.detail : undefined,
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

  if (!claimed) {
    return NextResponse.json(
      { error: 'Question was already answered' },
      { status: 409 },
    );
  }

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

  await postAnswerNote({
    task,
    workerId,
    type: 'update',
    title: 'Answer delivered to the running session',
    body: describeAnswerPath(decision),
  });

  return NextResponse.json({
    path: 'resume',
    reasonCode: decision.reasonCode,
    // Same task — the resumed worker continues under it. Callers navigate here.
    taskId: task?.id ?? null,
    workerId,
    message: describeAnswerPath(decision),
  });
}

/**
 * Cold path: the session cannot be resumed, so the answer becomes a new task.
 * This is the behaviour that shipped before resume existed, unchanged except
 * that it now says WHY it ran.
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

  // Claim the answer FIRST, atomically. `worker.waitingFor` was read outside the
  // write, so two humans answering the same question (or one double-submitting)
  // both passed the guard above: both inserted a "Continue:" retry task and both
  // wrote the worker row. Gate the state flip on the question still being open —
  // only the winner may create a task. Claiming before inserting also means a
  // loser leaves nothing behind, instead of an orphan retry task.
  //
  // Status is 'superseded', not 'completed': this worker did not finish its
  // task, it was replaced by the continuation task inserted below. Recording it
  // as 'completed' would count an answered question as a clean success in
  // get_failure_analytics / success-rate-by-role — neither true nor the
  // opposite (a genuine failure). 'superseded' is excluded from both buckets
  // (see IN_FLIGHT_WORKER_STATUSES in lib/failure-analytics.ts) and is included
  // in TERMINAL_WORKER_STATUSES (workers/[id]/route.ts) so a later PATCH from
  // the runner for this same worker is rejected instead of resurrecting it.
  //
  // This is correct for THIS path only. On the resume path the same worker row
  // goes on to reach a real terminal state, so superseding it there would hide
  // a genuine success or failure behind an exclusion.
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

  if (!claimed) {
    return NextResponse.json(
      { error: 'Question was already answered' },
      { status: 409 },
    );
  }

  // Create the new retry task. The field-by-field inheritance rules live with
  // buildContinuationTaskValues so this path and the unacknowledged-resume
  // sweep cannot drift into building different rows for the same event.
  let newTask;
  try {
    [newTask] = await db
      .insert(tasks)
      .values(
        buildContinuationTaskValues({
          task,
          workspaceId: worker.workspaceId,
          workerId: worker.id,
          branch: worker.branch,
          milestones,
          question,
          answer: message,
          delivery: deliveryRecord,
        }),
      )
      .returning();
  } catch (err) {
    // No transactions on neon-http: compensate by hand so a failed insert does
    // not leave the worker completed with the question gone and no retry task.
    console.error(`[Worker ${workerId}] Retry task insert failed, restoring question:`, err);
    await db
      .update(workers)
      .set({
        status: worker.status,
        waitingFor: worker.waitingFor,
        completedAt: worker.completedAt ?? null,
        updatedAt: new Date(),
      })
      .where(eq(workers.id, workerId));
    return NextResponse.json(
      { error: 'Failed to record response' },
      { status: 500 },
    );
  }

  if (task?.id) {
    await recordAnswerDelivery(task.id, task.context, deliveryRecord);

    // The worker on the OLD task was just superseded outside
    // PATCH /api/workers/[id], and the old task's own status is never flipped
    // to a terminal one here (recordAnswerDelivery only touches context) — it
    // stays whatever it was. Any path claims it held must still be released
    // now: the work continues under `newTask`'s id, not this one, so a claim
    // left here would strand every other task overlapping those paths
    // indefinitely.
    await releaseAndNotify(task.id, 'abandoned');
  }

  // Best-effort back-reference from the answered worker to its continuation, so
  // a later reader of THIS worker's row (a task-detail page opened from a stale
  // link, a post-supersession error report — see workers/[id]/route.ts) can
  // point at where the work actually continued without reconstructing it from
  // tasks.context.previousAttempt.workerId. Cold path only: on the resume path
  // there is no second task, and writing this worker's OWN task id here would
  // assert a supersession that did not happen. The answer already succeeded by
  // this point, so a failure here only means the link is missing.
  try {
    await db
      .update(workers)
      .set({ continuationTaskId: newTask.id })
      .where(eq(workers.id, workerId));
  } catch (err) {
    console.error(`[Worker ${workerId}] Failed to record continuation task link:`, err);
  }

  await postAnswerNote({
    task,
    workerId,
    type: args.credentialDetail ? 'warning' : 'update',
    title: args.credentialDetail
      ? 'Answer recorded, but the agent credential needs attention'
      : 'Answer started a fresh continuation',
    body: args.credentialDetail
      ? `${describeAnswerPath(decision)} Specifically, ${args.credentialDetail}. `
        + 'The continuation will not be able to run until it is reconnected.'
      : describeAnswerPath(decision),
  });

  return NextResponse.json({
    path: 'cold_continuation',
    reasonCode: decision.reasonCode,
    taskId: newTask.id,
    workerId,
    message: describeAnswerPath(decision),
  });
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
