/**
 * Who holds a pending task, and why (./explain-coordination): declared vs
 * inferred dependency edges, soft overlaps with their newest verdict, and the
 * last path-overlap holder. One loader, read by `explain` (lib/explain.ts) and
 * by the start probe (lib/coordination-probe.ts), so both report the same holds.
 */
import { db } from '@buildd/core/db';
import { gateEvents, tasks, workers } from '@buildd/core/db/schema';
import { desc, eq, inArray } from 'drizzle-orm';
import { readSoftOverlaps } from '@buildd/core/path-overlap';
import { buildCoordinationHolds, classifyHolderStall, coordinationGateDetail, type CoordinationHold, type CoordinationHolder } from '@/lib/explain-coordination';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';

export type HoldTask = { id: string; status: string; dependsOn?: string[] | null; pathManifest?: string[] | null; pathDeclaration?: unknown };

/** Newest gate events read for holders; matches explain's gate history. */
const GATE_ROWS_LIMIT = 10;

/**
 * The holds for `task` given its newest gate events. One extra read, only for
 * a pending task that names holders.
 */
export async function loadCoordinationHolds(
  task: HoldTask,
  gateDetails: Array<{ reason: string; detail: unknown }>,
): Promise<CoordinationHold[]> {
  if (task.status !== 'pending') return [];
  const ids = new Set<string>(task.dependsOn ?? []);
  for (const e of readSoftOverlaps(task.pathDeclaration)) ids.add(e.taskId);
  for (const g of gateDetails) {
    const blockingTaskId = coordinationGateDetail(g.detail)?.blockingTaskId;
    if (blockingTaskId) ids.add(blockingTaskId);
  }
  ids.delete(task.id);
  const rows = ids.size > 0
    ? await db.query.tasks.findMany({
        where: sqlWhere(inArray(tasks.id, [...ids])),
        columns: { id: true, title: true, status: true, pathManifest: true, startAt: true, context: true },
      })
    : [];
  const closedPr = new Set<string>();
  if (rows.length > 0) {
    const ws = await db.query.workers.findMany({
      where: sqlWhere(inArray(workers.taskId, rows.map(r => r.id))),
      columns: { taskId: true, prUrl: true, mergedAt: true, prLifecycleStatus: true },
    });
    for (const w of ws as Array<{ taskId: string | null; prUrl: string | null; mergedAt: Date | null; prLifecycleStatus: string | null }>) {
      if (w.taskId && w.prUrl && !w.mergedAt && w.prLifecycleStatus === 'closed') closedPr.add(w.taskId);
    }
  }
  const holders = new Map<string, CoordinationHolder>(
    (rows as Array<{ id: string; title: string | null; status: string; pathManifest: string[] | null; startAt: Date | null; context: unknown }>).map(r => [
      r.id,
      { id: r.id, title: r.title, status: r.status, pathManifest: r.pathManifest, stall: r.status === 'pending' ? classifyHolderStall({ startAt: r.startAt, context: r.context, prClosedUnmerged: closedPr.has(r.id) }) : null },
    ]),
  );
  return buildCoordinationHolds({ task, holders, gateDetails });
}

/** The same holds `explain` reports, reading the task's own gate events. */
export async function loadTaskCoordinationHolds(task: HoldTask): Promise<CoordinationHold[]> {
  if (task.status !== 'pending') return [];
  const rows = await db.query.gateEvents.findMany({
    where: sqlWhere(eq(gateEvents.taskId, task.id)),
    orderBy: sqlOrderBy([desc(gateEvents.occurredAt)]),
    limit: GATE_ROWS_LIMIT,
    columns: { reason: true, detail: true },
  });
  return loadCoordinationHolds(task, rows.map(r => ({ reason: r.reason ?? '', detail: r.detail })));
}
