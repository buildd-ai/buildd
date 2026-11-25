/**
 * The writes behind a resume in place (rules: in-place-resume-policy.ts).
 *
 * One live worker per task holds throughout: nothing here creates a worker or
 * frees the task for another claim. The resume message is queued on the SAME
 * worker row by a compare-and-swap, and the step from "pausing" to "resuming"
 * is claimed by one atomic UPDATE on the task, so two callers (the worker
 * PATCH that reports the pause and the sweep) cannot both resume it.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workers, tasks, missionNotes } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { LIVE_WORKER_STATUSES } from '@buildd/shared';
import { isTaskTier } from '@buildd/core/model-pin';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { appendInstructionHistory, enqueuePendingInstruction } from '@/lib/worker-instructions';
import { dispatchResumedTask } from '@/lib/task-dispatch-delivery';
import { ANSWER_PATH_REASONS, RESUME_ACK_DEADLINE_MS, isParked, type AnswerDeliveryRecord } from '@/lib/answer-resume';
import { PENDING_MODEL_CHANGE_KEY, readPendingModelChange } from '@/lib/live-model-change';
import { requestWorkerPause } from '@/lib/worker-pause';
import { endLiveWorkersForRequeue } from '@/lib/task-cancel';
import { wakeTask } from '@/lib/dispatch-authority';
import {
  IN_PLACE_RESUME_KEY, RESUME_HISTORY_KEY, NEW_ATTEMPT_REASONS,
  appendResumeHistory, describeResumeOutcome, inPlaceResumeMessage, newAttemptEntry, readInPlaceResume,
  type InPlaceResumeIntent, type NewAttemptReason, type ResumeHistoryEntry,
} from './in-place-resume-policy';

export * from './in-place-resume-policy';

type Ctx = Record<string, unknown>;
const ctxOf = (v: unknown): Ctx => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Ctx) : {});

/**
 * Merge `patch` into a task's context and drop `remove`, in one statement, so
 * a concurrent writer of another key is not overwritten.
 */
function contextMerge(patch: Ctx, remove: readonly string[] = []): SQL {
  let base: SQL = sql`COALESCE(${tasks.context}, '{}'::jsonb)`;
  for (const key of remove) base = sql`(${base} - ${key}::text)`;
  return sql`${base} || ${JSON.stringify(patch)}::jsonb`;
}

/** The model a tier or model edit would run the session on, or null when it names none. */
export async function resolveChangeTarget(
  task: { workspaceId: string; workspace?: { teamId?: string | null } | null },
  requested: { tier?: unknown; model?: unknown },
): Promise<{ tier: string | null; model: string } | null> {
  if (typeof requested.model === 'string' && requested.model.trim()) {
    return { tier: typeof requested.tier === 'string' ? requested.tier : null, model: requested.model.trim() };
  }
  if (typeof requested.tier !== 'string' || !isTaskTier(requested.tier)) return null;
  try {
    // Through the model-tiers slot: core does not import that module.
    const { TIER_MODEL } = await import('@/modules');
    const model = await TIER_MODEL.resolve(requested.tier, task.workspace?.teamId ?? null, task.workspaceId);
    return model ? { tier: requested.tier, model } : null;
  } catch (err) {
    console.error('[in-place-resume] tier did not resolve to a model:', err);
    return null;
  }
}

/** The task's live worker with what the plan and the resume write need. */
export async function loadLiveWorkerForResume(taskId: string) {
  return (await db.query.workers.findFirst({
    where: sqlWhere(and(eq(workers.taskId, taskId), inArray(workers.status, [...LIVE_WORKER_STATUSES]))),
    columns: {
      id: true, status: true, runner: true, waitingFor: true, updatedAt: true, parkedUntil: true,
      supportsInstructionAck: true, pendingInstructions: true, instructionHistory: true, workspaceId: true, taskId: true,
    },
    with: { workspace: true },
  })) ?? null;
}

/** The task a worker PATCH hook needs: its context, and its workspace for the cloud wake. */
export async function loadTaskForResume(taskId: string) {
  return (await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, taskId)),
    columns: { id: true, context: true, workspaceId: true, title: true, description: true, missionId: true, predictedModel: true },
    with: { workspace: true },
  })) ?? null;
}

export type ResumableWorker = NonNullable<Awaited<ReturnType<typeof loadLiveWorkerForResume>>>;

interface NoteTask { id: string; missionId?: string | null }

/** The task's activity: one system note. Never throws. */
export async function postResumeNote(task: NoteTask, workerId: string | null, title: string, body: string, type: 'update' | 'warning' = 'update') {
  await db.insert(missionNotes).values({
    missionId: task.missionId ?? null, taskId: task.id, workerId, authorType: 'system', type, title, body, status: 'open',
  }).catch((err: unknown) => console.error(`[Task ${task.id}] in-place resume note failed:`, err));
}

/**
 * Queue the resume message on the worker's own row. Only while it is still
 * parked and its queue is what was read: a second caller, or a worker that
 * moved on, writes nothing. Returns whether this call queued it.
 */
export async function queueInPlaceResume(args: {
  worker: Pick<ResumableWorker, 'id' | 'pendingInstructions' | 'instructionHistory' | 'parkedUntil' | 'workspaceId'> & { workspace?: unknown };
  task: { id: string; title?: string | null; description?: string | null; workspaceId: string };
  intent: InPlaceResumeIntent;
  now?: number;
}): Promise<boolean> {
  const { worker, task, intent } = args;
  const now = args.now ?? Date.now();
  const message = inPlaceResumeMessage(intent);
  const [queued] = await db
    .update(workers)
    .set({
      waitingFor: null,
      pendingInstructions: enqueuePendingInstruction(worker.pendingInstructions, message),
      instructionHistory: appendInstructionHistory(worker.instructionHistory, { message, isSensitive: false, deliveryState: 'pending' }),
      currentAction: 'Resuming the same session',
      updatedAt: new Date(now),
    })
    .where(and(
      eq(workers.id, worker.id),
      eq(workers.status, 'waiting_input'),
      sql`${workers.pendingInstructions} IS NOT DISTINCT FROM ${worker.pendingInstructions ?? null}`,
    ))
    .returning({ id: workers.id });
  if (!queued) return false;

  // The same record an answered question leaves, so a resume nobody
  // acknowledges degrades to a new attempt (cleanupUnresumedAnswers).
  const delivery: AnswerDeliveryRecord = {
    path: 'resume', reasonCode: 'resume_eligible', reason: ANSWER_PATH_REASONS.resume_eligible,
    workerId: worker.id, decidedAt: new Date(now).toISOString(),
    ackDeadlineAt: new Date(now + RESUME_ACK_DEADLINE_MS).toISOString(),
  };
  await db.update(tasks)
    .set({ context: contextMerge({ answerDelivery: delivery }), updatedAt: new Date(now) })
    .where(eq(tasks.id, task.id))
    .catch((err: unknown) => console.error(`[Task ${task.id}] in-place resume delivery record failed:`, err));

  await triggerEvent(channels.worker(worker.id), events.WORKER_COMMAND, { action: 'message', text: message, timestamp: now })
    .catch(() => { /* the queue is the contract; the push only makes it sooner */ });

  // A parked cloud worker has no container: wake one that re-attaches to it.
  if (isParked(worker.parkedUntil, now)) {
    await dispatchResumedTask(
      { id: task.id, title: task.title ?? '', description: task.description ?? null, workspaceId: task.workspaceId } as never,
      (worker.workspace ?? { id: worker.workspaceId }) as never,
      worker.id,
    ).catch((err: unknown) => { console.error(`[Worker ${worker.id}] task.resume dispatch failed:`, err); return false; });
  }
  return true;
}

/** Take the step from `pausing` to `resuming` for this worker. One caller wins. */
async function claimResumeStep(taskId: string, workerId: string): Promise<boolean> {
  const [row] = await db.update(tasks)
    .set({ context: sql`jsonb_set(${tasks.context}, '{inPlaceResume,phase}', '"resuming"'::jsonb)`, updatedAt: new Date() })
    .where(and(
      eq(tasks.id, taskId),
      sql`${tasks.context} -> 'inPlaceResume' ->> 'phase' = 'pausing'`,
      sql`${tasks.context} -> 'inPlaceResume' ->> 'workerId' = ${workerId}`,
    ))
    .returning({ id: tasks.id });
  return !!row;
}

interface HookTask { id: string; context: unknown; workspaceId: string; title?: string | null; description?: string | null; missionId?: string | null }

/**
 * Worker PATCH: the worker just parked. When its pause was asked for by a
 * tier/model change or a requeue, resume it at once, with nobody pressing
 * Resume. A pause a person asked for has no intent and stays paused.
 */
export async function resumeAfterPause(args: {
  worker: ResumableWorker | (Pick<ResumableWorker, 'id' | 'pendingInstructions' | 'instructionHistory' | 'parkedUntil' | 'workspaceId'> & { status: string; waitingFor: unknown; workspace?: unknown });
  task: HookTask | null | undefined;
}): Promise<boolean> {
  const { worker, task } = args;
  if (!task || worker.status !== 'waiting_input') return false;
  if ((worker.waitingFor as { type?: unknown } | null)?.type !== 'pause') return false;
  const intent = readInPlaceResume(task.context);
  if (!intent || intent.workerId !== worker.id || intent.phase !== 'pausing') return false;
  if (!(await claimResumeStep(task.id, worker.id))) return false;
  return queueInPlaceResume({ worker, task, intent: { ...intent, phase: 'resuming' } });
}

export interface ReactivationSettlement {
  /** The model the resumed session runs on. Sent to the runner on this response. */
  sessionModel?: string;
}

/**
 * Worker PATCH: the runner is resuming this worker's own session
 * (`status: running, reactivate: true`): after our message, after an answer,
 * or after the runner itself restarted. A model change waiting on this worker
 * is handed over here, and the outcome is recorded once.
 */
export async function settleOnReactivation(args: {
  worker: { id: string };
  task: (HookTask & { predictedModel?: string | null }) | null | undefined;
  /** The runner said it takes `sessionModel` from this response. */
  runnerTakesModel: boolean;
  now?: number;
}): Promise<ReactivationSettlement> {
  const { worker, task } = args;
  if (!task) return {};
  const ctx = ctxOf(task.context);
  const intent = readInPlaceResume(ctx);
  const pending = readPendingModelChange(ctx);
  const mine = intent && intent.workerId === worker.id ? intent : null;
  const pendingModel = pending && pending.workerId === worker.id ? (pending.resolvedModel ?? null) : null;
  const toModel = mine?.toModel ?? pendingModel;
  if (!mine && !toModel) return {};
  // Only a resume of the session itself settles it. A runner that takes a
  // model says so on that call; an older one is recognised by the resume
  // message it was sent. A retry or a recovery session reactivates the worker
  // too, and is neither.
  if (!args.runnerTakesModel && mine?.phase !== 'resuming') return {};

  const at = new Date(args.now ?? Date.now()).toISOString();
  const fromModel = mine?.fromModel ?? pending?.runningModel ?? null;
  const fromTier = mine?.fromTier ?? pending?.runningTier ?? null;
  const toTier = mine?.toTier ?? (pending && 'tier' in pending ? pending.tier ?? null : null);
  const cause = mine?.cause ?? 'model_change';
  const switched = !!toModel && args.runnerTakesModel;

  const entries: ResumeHistoryEntry[] = [{
    kind: 'resumed_in_place', cause, workerId: worker.id,
    fromModel, toModel: switched ? toModel : null, fromTier, toTier: switched ? toTier : null, at,
  }];
  if (toModel && !switched) {
    entries.push({
      kind: 'new_attempt', cause: 'model_change', workerId: worker.id, fromModel, toModel, fromTier, toTier,
      reasonCode: 'runner_ignored_model', reason: NEW_ATTEMPT_REASONS.runner_ignored_model, at,
    });
  }
  let history = ctx;
  for (const e of entries) history = { [RESUME_HISTORY_KEY]: appendResumeHistory(history, e) };

  const patch: Ctx = { [RESUME_HISTORY_KEY]: history[RESUME_HISTORY_KEY] };
  const remove: string[] = [IN_PLACE_RESUME_KEY];
  if (switched) {
    remove.push(PENDING_MODEL_CHANGE_KEY);
    patch.model = toModel;
    const rt = ctxOf(ctx.resolvedTier);
    if (toTier) patch.resolvedTier = { ...rt, tier: toTier };
  }
  await db.update(tasks)
    .set({ context: contextMerge(patch, remove), ...(switched ? { predictedModel: toModel } : {}), updatedAt: new Date() })
    .where(eq(tasks.id, task.id))
    .catch((err: unknown) => console.error(`[Task ${task.id}] in-place resume settle failed:`, err));

  for (const e of entries) {
    await postResumeNote(task, worker.id, e.kind === 'resumed_in_place' ? 'Resumed in place' : 'Model change waits for a new attempt', describeResumeOutcome(e), e.kind === 'resumed_in_place' ? 'update' : 'warning');
  }
  return switched ? { sessionModel: toModel! } : {};
}

/**
 * After the task write that recorded the intent: ask for the pause, or resume
 * a worker that is already parked. Returns false only when a running worker
 * stopped running before the pause landed; the sweep settles that intent.
 */
export async function startInPlaceResume(args: { worker: ResumableWorker; task: HookTask; intent: InPlaceResumeIntent }): Promise<boolean> {
  if (args.intent.phase === 'pausing') return requestWorkerPause(args.worker.id);
  // A lost compare-and-swap means the worker is already resuming by another
  // route; its resume call settles this intent (settleOnReactivation).
  await queueInPlaceResume(args);
  return true;
}

/**
 * Cron: intents that did not settle by themselves.
 *  - the worker is paused but the resume was never queued (the pause landed
 *    before the intent was written): resume it now;
 *  - the worker is gone: drop the intent, its end already decided the task;
 *  - the pause was not reached by its deadline: a model change waits for the
 *    next attempt, a requeue takes the new attempt it would have taken before.
 */
export async function sweepInPlaceResumes(now: Date = new Date()): Promise<{ resumed: number; fellBack: number; cleared: number }> {
  const out = { resumed: 0, fellBack: 0, cleared: 0 };
  const rows = await db.query.tasks.findMany({
    where: sqlWhere(sql`${tasks.context} -> 'inPlaceResume' ->> 'phase' = 'pausing'`),
    columns: { id: true, context: true, workspaceId: true, title: true, description: true, missionId: true, status: true },
    limit: 100,
  });
  for (const task of rows) {
    const intent = readInPlaceResume(task.context);
    if (!intent) continue;
    try {
      const worker = await loadLiveWorkerForResume(task.id);
      if (!worker || worker.id !== intent.workerId) {
        await db.update(tasks).set({ context: contextMerge({}, [IN_PLACE_RESUME_KEY]), updatedAt: now })
          .where(and(eq(tasks.id, task.id), sql`${tasks.context} -> 'inPlaceResume' ->> 'workerId' = ${intent.workerId}`));
        out.cleared++;
        continue;
      }
      if (worker.status === 'waiting_input' && (worker.waitingFor as { type?: unknown } | null)?.type !== 'permission') {
        if (await claimResumeStep(task.id, worker.id)
          && await queueInPlaceResume({ worker, task, intent: { ...intent, phase: 'resuming' }, now: now.getTime() })) out.resumed++;
        continue;
      }
      if (Date.parse(intent.pauseDeadlineAt) > now.getTime()) continue;

      const entry = newAttemptEntry({
        cause: intent.cause, workerId: worker.id, reasonCode: 'pause_not_reached',
        fromModel: intent.fromModel, toModel: intent.toModel, fromTier: intent.fromTier, toTier: intent.toTier, now: now.getTime(),
      });
      const requeue = intent.cause === 'requeue';
      // Claimed by removing the intent: a worker that parks in this instant
      // finds none and stays paused, it is never resumed and ended at once.
      const [claimed] = await db.update(tasks)
        .set({ context: contextMerge({ [RESUME_HISTORY_KEY]: appendResumeHistory(task.context, entry) }, [IN_PLACE_RESUME_KEY]), updatedAt: now })
        .where(and(eq(tasks.id, task.id), sql`${tasks.context} -> 'inPlaceResume' ->> 'phase' = 'pausing'`))
        .returning({ id: tasks.id });
      if (!claimed) continue;
      if (requeue) {
        // The order the owner's requeue has always used: end the live worker,
        // then free the task, so a new claim is never ended by this.
        await endLiveWorkersForRequeue(task.id);
        await db.update(tasks)
          .set({ status: 'pending', claimedBy: null, claimedAt: null, expiresAt: null, updatedAt: now })
          .where(eq(tasks.id, task.id));
        await wakeTask(task.id, 'manual.start').catch((err: unknown) => console.error(`[Task ${task.id}] requeue wake failed:`, err));
      }
      await postResumeNote(task, worker.id, 'New attempt', describeResumeOutcome(entry), 'warning');
      out.fellBack++;
    } catch (err) {
      console.error(`[in-place-resume] sweep failed for task ${task.id}:`, err);
    }
  }
  return out;
}
