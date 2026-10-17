import { db } from '@buildd/core/db';
import { missions, tasks } from '@buildd/core/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { sqlWhere, sqlOrderByFn } from '@buildd/core/db/relational-sql';
import { missionIntegrationBase } from '@buildd/core/mission-integration';
import { withDeliveryShip } from '@buildd/core/pr-shipped';
import { deliveryShipsForPrs, shipKey } from '@/lib/workflow/delivery-ship';
import {
  evaluateUpstreamGate,
  gateBlockedReason,
  type GateCondition,
  type GateTask,
  type GateVerdict,
  type UnmetCondition,
} from '@/lib/mission-dependency-gate';

type MissionForBlockCheck = {
  id: string;
  dependsOnMissionId: string | null;
  gateCondition: string;
  dependencyMetAt: Date | null;
};

export interface BlockedStatus {
  blocked: boolean;
  reason?: string;
  dependsOnTitle?: string;
  dependsOnMissionId?: string;
  /** What is still left on the upstream mission, first one first. Empty when unblocked. */
  unmet?: UnmetCondition[];
}

const asGate = (g: string | null | undefined): GateCondition => (g === 'completed' ? 'completed' : 'merged');

/**
 * Reads an upstream mission and decides a gate (`evaluateUpstreamGate`). A
 * read: nothing is written. Null when the upstream no longer exists.
 */
export async function evaluateMissionGate(
  upstreamMissionId: string,
  gate: GateCondition,
): Promise<(GateVerdict & { title: string }) | null> {
  const upstream = await db.query.missions.findFirst({
    where: sqlWhere(eq(missions.id, upstreamMissionId)),
    columns: { id: true, title: true, status: true, integrationBranchEnabled: true, workingBranch: true },
  });
  if (!upstream) return null;
  const head = { title: upstream.title, status: upstream.status, integrationBranch: missionIntegrationBase(upstream) !== null };
  // Completed meets both gates and the completed gate reads nothing else: no task load.
  if (upstream.status === 'completed' || gate === 'completed') return { ...evaluateUpstreamGate(gate, head, []), title: upstream.title };

  const rows = await db.query.tasks.findMany({
    where: sqlWhere(eq(tasks.missionId, upstreamMissionId)),
    columns: {
      id: true, title: true, status: true, taskClass: true, parentTaskId: true, mode: true, kind: true,
      category: true, creationSource: true, roleSlug: true, context: true, workspaceId: true,
    },
    with: {
      workers: {
        columns: {
          prUrl: true, prNumber: true, mergedAt: true, prLifecycleStatus: true,
          supersededByPrNumber: true, supersededByPrUrl: true, supersededReason: true, abandonedAt: true,
        },
        orderBy: sqlOrderByFn((w, { desc: d }) => [d(w.startedAt)]),
        limit: 1,
      },
    },
  });
  const latest = rows.map(r => ({ row: r, w: (r as unknown as { workers?: GateTask['worker'][] }).workers?.[0] ?? null }));
  const ships = await deliveryShipsForPrs(latest.flatMap(({ row, w }) => (w ? [{ workspaceId: row.workspaceId, prUrl: w.prUrl }] : [])));
  const gateTasks: GateTask[] = latest.map(({ row, w }) => ({
    id: row.id, title: row.title, status: row.status, taskClass: row.taskClass ?? null, parentTaskId: row.parentTaskId ?? null,
    mode: row.mode ?? null, kind: row.kind ?? null, category: row.category ?? null, creationSource: row.creationSource ?? null,
    roleSlug: row.roleSlug ?? null, context: row.context,
    worker: w ? withDeliveryShip(w, ships.get(shipKey(row.workspaceId, w.prUrl) ?? '')) : null,
  }));
  return { ...evaluateUpstreamGate(gate, head, gateTasks), title: upstream.title };
}

/** Stamp the gate cleared. Guarded on IS NULL, so only one writer clears it; true when this call did. */
async function stampDependencyMet(missionId: string, now = new Date()): Promise<boolean> {
  const [cleared] = await db
    .update(missions)
    .set({ dependencyMetAt: now, updatedAt: now })
    .where(and(eq(missions.id, missionId), isNull(missions.dependencyMetAt)))
    .returning({ id: missions.id });
  return !!cleared;
}

/**
 * Is the mission blocked by an unmet dependency?
 *
 * `dependencyMetAt` set: no. Otherwise the gate is decided from the upstream's
 * live state (`evaluateMissionGate`), not only from the events that stamp it:
 * those are lossy (a lost webhook, or a merge that fired while a sibling was
 * still open and nothing re-asked afterwards). A met gate is stamped here so
 * every later read agrees. A blocked answer names the first unmet condition.
 */
export async function isMissionBlocked(
  mission: MissionForBlockCheck,
): Promise<BlockedStatus> {
  if (!mission.dependsOnMissionId) {
    return { blocked: false };
  }

  if (mission.dependencyMetAt) {
    return { blocked: false };
  }

  const gate = asGate(mission.gateCondition);
  const verdict = await evaluateMissionGate(mission.dependsOnMissionId, gate);

  if (!verdict) {
    // Upstream deleted — unblock automatically
    return { blocked: false };
  }

  if (verdict.met) {
    await stampDependencyMet(mission.id).catch(err =>
      console.error(`[mission-dependency] stamping the met gate failed for ${mission.id}:`, err),
    );
    return { blocked: false };
  }

  return {
    blocked: true,
    reason: gateBlockedReason(verdict.title, gate, verdict.unmet),
    dependsOnTitle: verdict.title,
    dependsOnMissionId: mission.dependsOnMissionId,
    unmet: verdict.unmet,
  };
}

/**
 * Returns true if setting missionId.dependsOnMissionId = proposedDependsOnId
 * would create a cycle. Walks the dependency chain starting at proposedDependsOnId
 * and checks whether missionId appears (direct or transitive).
 */
export async function wouldCreateCycle(
  missionId: string,
  proposedDependsOnId: string,
): Promise<boolean> {
  if (missionId === proposedDependsOnId) return true;

  const MAX_DEPTH = 20;
  let currentId: string | null = proposedDependsOnId;
  const visited = new Set<string>();

  for (let i = 0; i < MAX_DEPTH; i++) {
    if (!currentId) return false;
    if (visited.has(currentId)) return false; // existing cycle in chain (shouldn't happen)
    visited.add(currentId);

    const node: { id: string; dependsOnMissionId: string | null } | undefined = await db.query.missions.findFirst({
      where: sqlWhere(eq(missions.id, currentId)),
      columns: { id: true, dependsOnMissionId: true },
    });

    if (!node) return false;
    if (node.dependsOnMissionId === missionId) return true;
    currentId = node.dependsOnMissionId;
  }

  return false;
}

/**
 * Called when an upstream mission satisfies the gate condition.
 * Finds all blocked dependents with a matching gateCondition and sets
 * their dependencyMetAt, releasing the block.
 *
 * For the `merged` signal the caller only knows that *a* PR merged, so the
 * mission-wide predicate is re-checked here rather than trusted. Putting it here
 * rather than at the call sites is deliberate: three separate places raise this
 * signal (the webhook's worker-match and branch-match paths, and the manual
 * merge route) and they must not be able to drift apart.
 *
 * The `completed` signal releases both gates: completion already required
 * everything the `merged` gate asks for, so a `merged` dependent must not be
 * left waiting on a merge event that fired before its upstream finished.
 *
 * Each unblocked mission is then woken (`wakeMission(id, 'dependency_met')`),
 * so its next step is planned now rather than on the next heartbeat tick.
 *
 * Returns the IDs of missions that were unblocked.
 */
export async function checkAndUnblockDependentMissions(
  upstreamMissionId: string,
  signal: 'completed' | 'merged',
  /** Injected for testing — defaults to wakeMission (lib/mission-wake.ts) */
  deps?: { wake?: (missionId: string, reason: 'dependency_met') => Promise<unknown> },
): Promise<string[]> {
  const dependents = await db.query.missions.findMany({
    where: sqlWhere(and(
      eq(missions.dependsOnMissionId, upstreamMissionId),
      isNull(missions.dependencyMetAt),
    )),
    columns: { id: true, gateCondition: true },
  });

  if (dependents.length === 0) return [];

  const toUnblock = signal === 'completed'
    ? dependents
    : dependents.filter(d => asGate(d.gateCondition) === 'merged');
  if (toUnblock.length === 0) return [];

  // Checked only after we know a dependent is actually waiting on this signal,
  // so the common no-dependents case costs no extra queries.
  if (signal === 'merged') {
    const verdict = await evaluateMissionGate(upstreamMissionId, 'merged');
    if (verdict && !verdict.met) return [];
  }

  const now = new Date();
  const unblockedIds: string[] = [];

  for (const dep of toUnblock) {
    // Guarded write, so only the caller whose write actually cleared the gate
    // wakes the mission: GitHub redelivers, and two merges can race here.
    if (await stampDependencyMet(dep.id, now)) unblockedIds.push(dep.id);
  }

  // Clearing the gate used to only let the next heartbeat tick through; a
  // mission without one stayed idle. Wake each one now (a no-op for manual,
  // held or otherwise ineligible missions; never throws). Dynamic import:
  // mission-wake → mission-loop → this module.
  if (unblockedIds.length > 0) {
    const wake = deps?.wake ?? (await import('@/lib/mission-wake')).wakeMission;
    for (const id of unblockedIds) {
      await wake(id, 'dependency_met');
    }
  }

  return unblockedIds;
}
