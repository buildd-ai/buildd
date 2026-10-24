/**
 * Start anyway on the server side (spec 36df686b): the pieces the start route,
 * the claim, the wait exit and the views share. The pure decisions live in
 * @buildd/core/start-anyway; the request itself is the existing force-start
 * intent (lib/force-start.ts), so there is one authoritative start path.
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { desc, inArray } from 'drizzle-orm';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { readForceStart, FORCE_START_HISTORY_KEY, type ForceStartIntent } from '@buildd/core/waiting-reason';
import { buildAssessmentBrief, startAnywayPhase, type PrerequisiteInput, type StartAnywayPhase } from '@buildd/core/start-anyway';

/** An accepted, unconsumed request that admits declared edges for assessment. */
export function startAnywayAdmits(context: Record<string, unknown> | null | undefined, now: Date = new Date()): boolean {
  return (readForceStart(context, now)?.assessDependsOn?.length ?? 0) > 0;
}

export const START_ANYWAY_ASSESSMENT_KEY = 'startAnywayAssessment' as const;
export const START_ANYWAY_PARKS_KEY = 'startAnywayParks' as const;

/** The consumed intent of this task's newest Start anyway, when it admitted declared edges. */
export function lastStartAnyway(context: Record<string, unknown> | null | undefined): (ForceStartIntent & { claimedAt?: string }) | null {
  const h = context?.[FORCE_START_HISTORY_KEY];
  if (!Array.isArray(h)) return null;
  for (let i = h.length - 1; i >= 0; i--) {
    const e = h[i] as ForceStartIntent & { claimedAt?: string };
    if (e && Array.isArray(e.assessDependsOn) && e.assessDependsOn.length > 0) return e;
  }
  return null;
}

/** What the claim stores for the agent: the assessment prompt with the prerequisites' live state at claim. */
export function assessmentContext(
  task: { id: string; title: string; context: Record<string, unknown> | null },
  prerequisites: PrerequisiteInput[],
  at: Date,
) {
  const brief = buildAssessmentBrief({
    task: { id: task.id, title: task.title, specId: ((task.context as { specSource?: { specId?: string } } | null)?.specSource?.specId) ?? null },
    prerequisites,
    recoveryOutcomes: [],
  });
  return { at: at.toISOString(), text: brief.text, facts: brief.facts };
}

/** The prerequisites' live state now: their task, newest worker and PR. Missing rows read as unknown. */
export async function loadPrerequisites(ids: readonly string[]): Promise<PrerequisiteInput[]> {
  if (ids.length === 0) return [];
  const [rows, ws] = await Promise.all([
    db.query.tasks.findMany({ where: sqlWhere(inArray(tasks.id, [...ids])), columns: { id: true, title: true, status: true } }),
    db.query.workers.findMany({
      where: sqlWhere(inArray(workers.taskId, [...ids])),
      columns: { id: true, taskId: true, status: true, prUrl: true, prNumber: true, mergedAt: true },
      orderBy: sqlOrderBy([desc(workers.createdAt)]),
    }),
  ]);
  return rows.map(t => {
    const w = ws.find(x => x.taskId === t.id);
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      worker: w ? { id: w.id, status: w.status } : null,
      pr: w?.prUrl ? { url: w.prUrl, number: w.prNumber, merged: !!w.mergedAt } : null,
    };
  });
}

export interface StartAnywayView {
  phase: StartAnywayPhase;
  label: string;
  /** Counts toward executing capacity (a parked or merely requested task does not). */
  executing: boolean;
  taskStatus: 'pending' | 'in_progress';
  blockerTaskId?: string;
  nextStep?: string;
}

/**
 * The observed Start anyway phase from the task row's own facts, for every
 * surface (task page and sheet, Queue, explain, runner): requested before a
 * claim, assessing while claimed, blocked on its prerequisite after the wait
 * exit. Null when the task was never started this way or is finished.
 */
export function startAnywayView(i: {
  context: Record<string, unknown> | null | undefined;
  status: string;
  now: Date;
  prerequisiteTitle?: string | null;
}): StartAnywayView | null {
  if (i.status !== 'pending' && i.status !== 'assigned' && i.status !== 'in_progress') return null;
  const intent = readForceStart(i.context, i.now);
  const pendingRequest = i.status === 'pending' && (intent?.assessDependsOn?.length ?? 0) > 0;
  const last = lastStartAnyway(i.context);
  if (!pendingRequest && !last) return null;
  const wait = i.context?.waitExit as { blockerTaskId?: string; reason?: string; at?: string } | undefined;
  const parked = !pendingRequest && !!last && i.status === 'pending' && !!wait?.blockerTaskId && !!wait.at && !!last.claimedAt && wait.at >= last.claimedAt;
  const claimed = !pendingRequest && !!last;
  const p = startAnywayPhase({
    intent: { id: (pendingRequest ? intent! : last!).id },
    claimed,
    parked,
    executing: claimed && !parked,
    prerequisite: i.prerequisiteTitle ? { title: i.prerequisiteTitle } : { title: wait?.blockerTaskId ? `task ${wait.blockerTaskId.slice(0, 8)}` : 'its prerequisite' },
    nextStep: wait?.reason ?? null,
  });
  return {
    ...p,
    executing: p.phase === 'assessing',
    ...(parked ? { blockerTaskId: wait!.blockerTaskId, nextStep: wait!.reason } : {}),
  };
}
