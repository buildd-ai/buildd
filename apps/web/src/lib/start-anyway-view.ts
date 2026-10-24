/**
 * The one Start anyway reading every surface shows (Living Spec 36df686b
 * R-12, AC-16): the task sheet, the task page and the mission drawer (through
 * GET /api/tasks/[id]/waiting), explain, and the runner. Observed facts only:
 * a request not yet claimed reads "requested", never running; a live worker
 * reads assessing or working; a park names its prerequisite and next step; a
 * prerequisite that failed says a person decides. The words are
 * `startAnywayPhase` in @buildd/core/start-anyway, so no surface words it
 * twice.
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { LIVE_WORKER_STATUSES } from '@buildd/shared';
import { readForceStart } from '@buildd/core/waiting-reason';
import { readStartAnyway, startAnywayPhase, type PhaseView } from '@buildd/core/start-anyway';
import { sqlWhere } from '@buildd/core/db/relational-sql';

export interface StartAnywayView extends PhaseView {
  prerequisite: { id: string; title: string; status: string } | null;
  nextStep: string | null;
  /** Counts toward executing capacity: a live worker, not a request or a park. */
  executing: boolean;
}

/** The facts behind the view, already read: pure, for tests and batch callers. */
export function startAnywayViewOf(input: {
  context: Record<string, unknown> | null;
  status: string;
  liveWorker: boolean;
  prerequisites: ReadonlyMap<string, { title: string; status: string }>;
  now?: Date;
}): StartAnywayView | null {
  const now = input.now ?? new Date();
  const intent = readForceStart(input.context, now);
  const requested = intent?.assessDependsOn?.length ? intent : null;
  const record = readStartAnyway(input.context);
  if (!requested && !record) return null;
  const ids = requested?.assessDependsOn ?? record?.prerequisiteIds ?? [];
  // The prerequisite a park waits on, else the first one still unfinished.
  const leadId = record?.wake?.taskId
    ?? ids.find(id => !['completed', 'cancelled'].includes(input.prerequisites.get(id)?.status ?? ''))
    ?? ids[0] ?? null;
  const lead = leadId ? input.prerequisites.get(leadId) : undefined;
  const prerequisite = leadId ? { id: leadId, title: lead?.title ?? `task ${leadId.slice(0, 8)}`, status: lead?.status ?? 'missing' } : null;
  const nextStep = record?.assessment?.nextStep ?? null;
  // A finished task's lifecycle is history, not a phase.
  if (!requested && !['pending', 'assigned', 'in_progress'].includes(input.status)) return null;
  const parked = !requested && record?.phase === 'parked';
  // A record left by an earlier lifecycle that is neither live nor parked is not a phase either,
  // and neither is a live run whose prerequisite has since landed: it is ordinary work now.
  if (!requested && !parked && (!input.liveWorker || ['completed', 'cancelled'].includes(prerequisite?.status ?? ''))) return null;
  const view = startAnywayPhase({
    intent: requested ? { id: requested.id } : null,
    claimed: !requested,
    parked,
    executing: !requested && input.liveWorker,
    assessed: !!record?.assessment,
    prerequisite: prerequisite ? { title: prerequisite.title, status: prerequisite.status } : null,
    nextStep,
  });
  return { ...view, prerequisite, nextStep, executing: view.phase === 'assessing' || view.phase === 'working' };
}

/** Read the facts for one task and derive its view. Null: no Start anyway on it. */
export async function loadStartAnywayView(task: { id: string; status: string; context: unknown }): Promise<StartAnywayView | null> {
  const context = (task.context ?? null) as Record<string, unknown> | null;
  const intent = readForceStart(context, new Date());
  const record = readStartAnyway(context);
  const ids = [...new Set([...(intent?.assessDependsOn ?? []), ...(record?.prerequisiteIds ?? [])])];
  if (ids.length === 0) return null;
  const [rows, live] = await Promise.all([
    db.query.tasks.findMany({ where: sqlWhere(inArray(tasks.id, ids)), columns: { id: true, title: true, status: true } }),
    db.query.workers.findFirst({
      where: sqlWhere(and(eq(workers.taskId, task.id), inArray(workers.status, [...LIVE_WORKER_STATUSES]))),
      columns: { id: true },
    }),
  ]);
  return startAnywayViewOf({
    context,
    status: task.status,
    liveWorker: !!live,
    prerequisites: new Map(rows.map(r => [r.id, { title: r.title, status: r.status }])),
  });
}
