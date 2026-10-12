/**
 * Who holds a pending task, and why (./explain-coordination): declared vs
 * inferred dependency edges, soft overlaps with their newest verdict, and the
 * last path-overlap holder. One loader, read by `explain` (lib/explain.ts) and
 * by the start probe (lib/coordination-probe.ts), so both report the same holds.
 */
import { db } from '@buildd/core/db';
import { gateEvents, tasks } from '@buildd/core/db/schema';
import { desc, eq, inArray } from 'drizzle-orm';
import { readSoftOverlaps } from '@buildd/core/path-overlap';
import { buildCoordinationHolds, coordinationGateDetail, type CoordinationHold, type CoordinationHolder } from '@/lib/explain-coordination';

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
        where: inArray(tasks.id, [...ids]),
        columns: { id: true, title: true, status: true, pathManifest: true },
      })
    : [];
  const holders = new Map<string, CoordinationHolder>(
    (rows as Array<{ id: string; title: string | null; status: string; pathManifest: string[] | null }>).map(r => [r.id, r]),
  );
  return buildCoordinationHolds({ task, holders, gateDetails });
}

/** The same holds `explain` reports, reading the task's own gate events. */
export async function loadTaskCoordinationHolds(task: HoldTask): Promise<CoordinationHold[]> {
  if (task.status !== 'pending') return [];
  const rows = await db.query.gateEvents.findMany({
    where: eq(gateEvents.taskId, task.id),
    orderBy: [desc(gateEvents.occurredAt)],
    limit: GATE_ROWS_LIMIT,
    columns: { reason: true, detail: true },
  });
  return loadCoordinationHolds(task, rows.map(r => ({ reason: r.reason ?? '', detail: r.detail })));
}
