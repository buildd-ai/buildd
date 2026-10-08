/**
 * Slice D's effects (docs/specs/workflow-state-kernel.md §10.2, T18/T20/T21):
 * what a closed PR's resolution owes after the kernel decided it.
 *
 *  - `scan_supersession` (T18): look for where a closed-unmerged PR's work
 *    landed. Detection only nominates; an edge it can prove goes back in as T20
 *    through `recordPrSupersession`, never as a column write.
 *  - `project_supersession` (T20, T21): the delivery's resolution onto every
 *    worker row of the PR, `supersededBy*` or `abandoned*` (§12: a projection,
 *    written only here). Never overwrites an edge already on a row.
 *  - `wake_mission` (T20, T21): the mission may be completable now.
 *
 * Owned by the reviews module (supersession detection lives there) and
 * composed at the root (apps/web/src/modules.ts). Each handler re-reads the
 * delivery and acts only on what is still owed.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import type { EffectHandler, EffectHandlers } from './effects';
import { loadView, type Exec } from './kernel';
import { prUrlOf } from './pr-fact-effects';
import type { DeliverySnapshot } from './types';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

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

export const projectSupersession: EffectHandler = async (e) => {
  const d = (await loadView({ deliveryId: e.deliveryId }, dbExec)).delivery;
  if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
  const now = new Date();
  if (d.state === 'SUPERSEDED' && d.supersededByPr != null) {
    const rows = await db.update(workers).set({
      supersededByPrNumber: d.supersededByPr,
      supersededByPrUrl: d.supersededByUrl ?? null,
      supersededReason: d.supersededReason ?? null,
      supersededRecordedBy: recordedByLabel(d.recordedBy),
      supersededAt: now,
      updatedAt: now,
    }).where(and(prRows(d), isNull(workers.supersededByPrNumber))).returning({ id: workers.id });
    return { outcome: `ok:superseded_${rows.length}` };
  }
  if (d.state === 'ABANDONED') {
    const rows = await db.update(workers).set({
      abandonedReason: d.stateReason ?? null,
      abandonedRecordedBy: recordedByLabel(d.recordedBy),
      abandonedAt: now,
      updatedAt: now,
    }).where(and(prRows(d), isNull(workers.abandonedAt))).returning({ id: workers.id });
    return { outcome: `ok:abandoned_${rows.length}` };
  }
  return { outcome: `skipped:state_${d.state}` };
};

export const wakeMissionOnResolution: EffectHandler = async (e) => {
  const d = (await loadView({ deliveryId: e.deliveryId }, dbExec)).delivery;
  if (!d) return { outcome: 'skipped:no_delivery' };
  const owner = await db.query.tasks.findFirst({ where: eq(tasks.id, d.ownerTaskId), columns: { missionId: true } });
  if (!owner?.missionId) return { outcome: 'skipped:no_mission' };
  const { wakeMission } = await import('@/lib/mission-wake');
  const r = await wakeMission(owner.missionId, 'pr_resolved');
  return { outcome: r.woken ? 'ok:woken' : `ok:not_woken_${r.reason}` };
};

export const scanSupersession: EffectHandler = async (e) => {
  const d = (await loadView({ deliveryId: e.deliveryId }, dbExec)).delivery;
  if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
  // Reopened, or already resolved by a person or an earlier scan: nothing to find.
  if (d.state !== 'CLOSED_UNMERGED') return { outcome: `skipped:state_${d.state}` };
  const w = await db.query.workers.findFirst({
    where: prRows(d),
    columns: { id: true },
    orderBy: [desc(workers.createdAt)],
  });
  if (!w) return { outcome: 'skipped:no_worker' };
  const { detectPrSupersession } = await import('@/lib/pr-supersession-detect');
  const r = await detectPrSupersession({ workerId: w.id, via: 'kernel', delivery: { state: d.state } });
  return { outcome: `ok:${r.outcome}` };
};

export function withSupersessionEffects(base: EffectHandlers): EffectHandlers {
  return { ...base, scan_supersession: scanSupersession, project_supersession: projectSupersession, wake_mission: wakeMissionOnResolution };
}
