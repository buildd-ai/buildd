/**
 * What a tier/model change means for a task that already has a live agent.
 *
 * PATCH /api/tasks/[id] writes `tasks.tier` / a model pin for the NEXT claim or
 * retry; the running session keeps the model it was claimed with. Without a
 * notice the task reads as if it had run at the new tier. This builds the
 * `modelChange` block the PATCH reply carries so the caller (and update_task's
 * MCP reply) can say which tier the live run is on and how to rerun it now.
 */

export interface LiveModelChangeNotice {
  /**
   * `resume_in_place`: the run is paused at a safe point and its own session
   * continues on the new model (lib/in-place-resume.ts). `next_attempt`: the
   * session could not be kept, so the running attempt keeps its model.
   */
  appliesTo: 'resume_in_place' | 'next_attempt';
  /** The model the session continues on, when the change resolved to one. */
  targetModel?: string | null;
  /** next_attempt only: why the session could not be resumed in place. */
  reasonCode?: string;
  reason?: string;
  workerId: string;
  workerStatus: string;
  /** Tier the claim resolved for the live run (`context.resolvedTier.tier`), null when unrecorded. */
  runningTier: string | null;
  /** Model the claim resolved for the live run (`tasks.predicted_model`, else `context.model`). */
  runningModel: string | null;
  message: string;
}

function readRunning(task: { predictedModel?: string | null; context?: unknown }): { tier: string | null; model: string | null } {
  const ctx = task.context && typeof task.context === 'object' && !Array.isArray(task.context)
    ? task.context as Record<string, unknown>
    : {};
  const rt = ctx.resolvedTier;
  const tier = rt && typeof rt === 'object' && typeof (rt as Record<string, unknown>).tier === 'string'
    ? ((rt as Record<string, unknown>).tier as string)
    : null;
  const predicted = typeof task.predictedModel === 'string' && task.predictedModel.trim() ? task.predictedModel.trim() : null;
  const ctxModel = typeof ctx.model === 'string' && ctx.model.trim() ? ctx.model.trim() : null;
  return { tier, model: predicted ?? ctxModel };
}

export function liveModelChangeNotice(
  task: { predictedModel?: string | null; context?: unknown },
  worker: { id: string; status: string },
  outcome?: { inPlace: true; targetModel: string; paused: boolean } | { inPlace: false; targetModel?: string | null; reasonCode: string; reason: string },
): LiveModelChangeNotice {
  const { tier, model } = readRunning(task);
  const running = [tier, model].filter(Boolean).join(', ') || 'the model it was claimed with';
  if (outcome?.inPlace) {
    return {
      appliesTo: 'resume_in_place',
      targetModel: outcome.targetModel,
      workerId: worker.id,
      workerStatus: worker.status,
      runningTier: tier,
      runningModel: model,
      message:
        `Resuming in place: worker ${worker.id} ${outcome.paused ? 'is paused' : 'pauses at its next safe point'} and continues the same session on ${outcome.targetModel} (it was at ${running}). ` +
        'Its transcript and worktree are kept; only the prompt cache is rebuilt. If the pause or the resume does not happen, the change applies to a new attempt and the task activity says so.',
    };
  }
  if (outcome) {
    return {
      appliesTo: 'next_attempt',
      targetModel: outcome.targetModel ?? null,
      reasonCode: outcome.reasonCode,
      reason: outcome.reason,
      workerId: worker.id,
      workerStatus: worker.status,
      runningTier: tier,
      runningModel: model,
      message:
        `New attempt: worker ${worker.id} (${worker.status}) keeps running at ${running}, because ${outcome.reason}. The new tier/model applies from the next attempt. ` +
        'To restart it now, set status: pending (the session is kept when it can be resumed; otherwise unpushed work is lost).',
    };
  }
  return {
    appliesTo: 'next_attempt',
    workerId: worker.id,
    workerStatus: worker.status,
    runningTier: tier,
    runningModel: model,
    message:
      `Worker ${worker.id} (${worker.status}) is still running at ${running}; the new tier/model applies to the next attempt only. ` +
      'To rerun at it now, set status: pending (ends the live worker and requeues the task; unpushed work is lost).',
  };
}

/**
 * `tasks.context` key holding a tier/model change made while an agent was
 * running. The claim route deletes it: from the next claim on, the change is
 * simply what the task runs at.
 */
export const PENDING_MODEL_CHANGE_KEY = 'pendingModelChange';

export interface PendingModelChange {
  /** The requested tier, null when cleared, absent when only the model changed. */
  tier?: string | null;
  model?: string | null;
  /** The model the change resolved to when it was made, null when it named none. */
  resolvedModel?: string | null;
  runningTier: string | null;
  runningModel: string | null;
  workerId: string;
  at: string;
}

export function pendingModelChangeRecord(
  notice: LiveModelChangeNotice,
  requested: { tier?: unknown; model?: unknown },
  now: Date = new Date(),
): PendingModelChange {
  return {
    ...(requested.tier !== undefined ? { tier: (requested.tier as string | null) ?? null } : {}),
    ...(requested.model !== undefined ? { model: typeof requested.model === 'string' ? requested.model.trim() : null } : {}),
    ...(notice.targetModel ? { resolvedModel: notice.targetModel } : {}),
    runningTier: notice.runningTier,
    runningModel: notice.runningModel,
    workerId: notice.workerId,
    at: now.toISOString(),
  };
}

/** Read the pending change back off a task context; null when absent or malformed. */
export function readPendingModelChange(context: unknown): PendingModelChange | null {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  const raw = (context as Record<string, unknown>)[PENDING_MODEL_CHANGE_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.workerId !== 'string') return null;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    ...('tier' in r ? { tier: str(r.tier) } : {}),
    ...('model' in r ? { model: str(r.model) } : {}),
    ...(str(r.resolvedModel) ? { resolvedModel: str(r.resolvedModel) } : {}),
    runningTier: str(r.runningTier),
    runningModel: str(r.runningModel),
    workerId: r.workerId,
    at: str(r.at) ?? '',
  };
}
