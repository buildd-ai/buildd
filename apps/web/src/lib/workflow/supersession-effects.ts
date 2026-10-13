/**
 * buildd's half of Slice D's effects (docs/specs/workflow-state-kernel.md
 * §10.2, T18/T20/T21): what a closed PR's resolution owes after the kernel
 * decided it. The handlers (`scan_supersession`, `project_supersession`,
 * `wake_mission`) are the package's (packages/workflow-kernel/src/handlers/
 * supersession.ts), composed at the root (apps/web/src/modules.ts); each
 * re-reads the delivery and asks this file's `supersessionLifecycle` only for
 * what is still owed:
 *
 *  - `scanSupersession` (T18): look for where a closed-unmerged PR's work
 *    landed. Detection only nominates; an edge it can prove goes back in as T20
 *    through `recordPrSupersession`, never as a column write.
 *  - `projectResolution` (T20, T21): the delivery's resolution onto every
 *    worker row of the PR, `supersededBy*` or `abandoned*` (§12: a projection,
 *    written only here). Never overwrites an edge already on a row.
 *  - `wakeCoordinator` (T20, T21): the owner's mission may be completable now.
 *
 * Owned by the reviews module (supersession detection lives there).
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import type { Lifecycle } from '@buildd/workflow-kernel/ports';
import { prUrlOf } from './pr-fact-effects';
import type { DeliverySnapshot } from './types';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';

/** `human:<who>` is the kernel's actor; the worker column keeps the plain label it always held. */
const recordedByLabel = (actor: string | null | undefined): string => (actor?.startsWith('human:') ? actor.slice('human:'.length) : actor) || 'unknown';

function prRows(d: DeliverySnapshot & { repoFullName: string; prNumber: number }) {
  return and(
    eq(workers.workspaceId, d.workspaceId),
    eq(workers.prUrl, prUrlOf(d.repoFullName, d.prNumber)),
    eq(workers.prNumber, d.prNumber),
    isNull(workers.mergedAt),
  );
}

const hasPr = (d: DeliverySnapshot | null): d is DeliverySnapshot & { repoFullName: string; prNumber: number } =>
  !!d?.repoFullName && d.prNumber != null;

export const supersessionLifecycle: Pick<Lifecycle, 'projectResolution' | 'scanSupersession' | 'wakeCoordinator'> = {
  async projectResolution(d, resolution) {
    if (!hasPr(d)) return 0;
    const now = new Date();
    if (resolution === 'superseded') {
      const rows = await db.update(workers).set({
        supersededByPrNumber: d.supersededByPr,
        supersededByPrUrl: d.supersededByUrl ?? null,
        supersededReason: d.supersededReason ?? null,
        supersededRecordedBy: recordedByLabel(d.recordedBy),
        supersededAt: now,
        updatedAt: now,
      }).where(and(prRows(d), isNull(workers.supersededByPrNumber))).returning({ id: workers.id });
      return rows.length;
    }
    const rows = await db.update(workers).set({
      abandonedReason: d.stateReason ?? null,
      abandonedRecordedBy: recordedByLabel(d.recordedBy),
      abandonedAt: now,
      updatedAt: now,
    }).where(and(prRows(d), isNull(workers.abandonedAt))).returning({ id: workers.id });
    return rows.length;
  },

  async wakeCoordinator(d, reason) {
    const owner = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, d.ownerTaskId)), columns: { missionId: true } });
    if (!owner?.missionId) return null;
    const { wakeMission } = await import('@/lib/mission-wake');
    const r = await wakeMission(owner.missionId, reason);
    return r.woken ? { woken: true } : { woken: false, reason: r.reason };
  },

  async scanSupersession(d) {
    if (!hasPr(d)) return null;
    const w = await db.query.workers.findFirst({
      where: sqlWhere(prRows(d)),
      columns: { id: true },
      orderBy: sqlOrderBy([desc(workers.createdAt)]),
    });
    if (!w) return null;
    const { detectPrSupersession } = await import('@/lib/pr-supersession-detect');
    const r = await detectPrSupersession({ workerId: w.id, via: 'kernel', delivery: { state: d.state } });
    return r.outcome;
  },
};
