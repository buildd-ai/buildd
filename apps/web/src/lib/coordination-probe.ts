/**
 * Read-only probe: which coordination gates would the next claim defer this
 * task for, right now? Loads the claim route's own snapshot for the task's
 * workspace and mission (`claim/coordination-snapshot`) and evaluates the
 * claim route's own predicates (`claim/coordination-gates`), so `/start` can
 * refuse with the real blocker instead of accepting a start no runner will
 * take.
 *
 * Never throws: a probe failure returns `null` (unknown) and the caller falls
 * back to today's behaviour rather than blocking a start on a read error.
 */
import { db } from '@buildd/core/db';
import { gateEvents, tasks, workers } from '@buildd/core/db/schema';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { getActiveClaimsByWorkspace } from '@buildd/core/path-claim';
import type { WaitingReason } from '@buildd/core/waiting-reason';
import { evaluateCoordinationGates } from '@/app/api/workers/claim/coordination-gates';
import { loadMissionCoordination, loadOpenPrTasksByWorkspace } from '@/app/api/workers/claim/coordination-snapshot';
import { ORDERED_BEHIND_REASON } from '@/app/api/workers/claim/claim-plan-store';
import { GATE_SLUGS } from '@buildd/core/gate-events';

const LIVE = ['running', 'starting', 'idle', 'waiting_input'] as const;
/**
 * `ordered_behind` is written once per (task, blocker), never refreshed, so
 * the blocker's liveness is what says it still applies; this only bounds the read.
 */
const ORDERED_BEHIND_FRESH_MS = 6 * 60 * 60 * 1000;

export interface ProbeTask {
  id: string;
  workspaceId: string;
  missionId?: string | null;
  pathManifest?: unknown;
  category?: unknown;
  context?: unknown;
  outputRequirement?: unknown;
  [k: string]: unknown;
}

export async function probeCoordination(task: ProbeTask, now: Date = new Date()): Promise<WaitingReason[] | null> {
  try {
    const missionId = (task.missionId as string | null) ?? null;
    const [openPrByWs, activeClaims, missionData, orderedRow] = await Promise.all([
      loadOpenPrTasksByWorkspace([task.workspaceId]),
      getActiveClaimsByWorkspace(task.workspaceId).catch(() => null),
      missionId ? loadMissionCoordination([missionId]) : Promise.resolve(null),
      db.select({ detail: gateEvents.detail, occurredAt: gateEvents.occurredAt })
        .from(gateEvents)
        .where(and(
          eq(gateEvents.taskId, task.id),
          eq(gateEvents.gate, GATE_SLUGS.CLAIM_LOOP_DEFERRAL),
          eq(gateEvents.reason, ORDERED_BEHIND_REASON),
          gte(gateEvents.occurredAt, new Date(now.getTime() - ORDERED_BEHIND_FRESH_MS)),
        ))
        .orderBy(desc(gateEvents.occurredAt))
        .limit(1)
        .then(rows => rows[0] ?? null)
        .catch(() => null),
    ]);

    const orderedDetail = (orderedRow?.detail ?? null) as Record<string, unknown> | null;
    const orderedBehind = typeof orderedDetail?.blockedBy === 'string'
      ? {
          blockedBy: orderedDetail.blockedBy,
          edge: typeof orderedDetail.edge === 'string' ? orderedDetail.edge : null,
          since: orderedRow?.occurredAt ? new Date(orderedRow.occurredAt).toISOString() : null,
        }
      : null;

    const candidateHolders = [
      ...(activeClaims ? [...activeClaims.keys()] : []),
      ...(orderedBehind ? [orderedBehind.blockedBy] : []),
    ].filter(id => id !== task.id);
    const liveRows = candidateHolders.length > 0
      ? await db.query.workers.findMany({
          where: and(inArray(workers.taskId, candidateHolders), inArray(workers.status, [...LIVE])),
          columns: { taskId: true },
        })
      : [];

    const reasons = evaluateCoordinationGates(task, {
      openPrTasks: openPrByWs.get(task.workspaceId) ?? [],
      activeClaims,
      mission: missionId ? (missionData?.missionClaimMap.get(missionId) ?? null) : null,
      missionActiveCount: missionId ? (missionData?.missionActiveCountMap.get(missionId) ?? 0) : 0,
      missionAdvisoryInFlight: missionId ? (missionData?.missionAdvisoryInFlight.get(missionId) ?? null) : null,
      orderedBehind,
      liveTaskIds: new Set(liveRows.map(r => r.taskId).filter((id): id is string => !!id)),
      now,
    });
    return await withTaskLabels(reasons);
  } catch (err) {
    console.warn(`[coordination-probe] task ${task.id}: probe failed, start proceeds unprobed:`, (err as Error)?.message ?? err);
    return null;
  }
}

/** Replace "task 1a2b3c4d" blocker labels with the blocker's title. */
async function withTaskLabels(reasons: WaitingReason[]): Promise<WaitingReason[]> {
  const ids = [...new Set(reasons.filter(r => r.blocker?.type === 'task').map(r => r.blocker!.id))];
  if (ids.length === 0) return reasons;
  const rows = await db.query.tasks.findMany({ where: inArray(tasks.id, ids), columns: { id: true, title: true } }).catch(() => []);
  const titles = new Map(rows.map(r => [r.id, r.title as string | null]));
  return reasons.map(r => {
    const title = r.blocker?.type === 'task' ? titles.get(r.blocker.id) : null;
    if (!title) return r;
    const label = title.length > 60 ? `${title.slice(0, 57)}…` : title;
    return { ...r, blocker: { ...r.blocker!, label: `“${label}”` } };
  });
}

