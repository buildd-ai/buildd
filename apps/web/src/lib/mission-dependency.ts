import { db } from '@buildd/core/db';
import { missions, tasks, workers } from '@buildd/core/db/schema';
import { eq, and, or, ne, isNull, isNotNull, inArray, count } from 'drizzle-orm';

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
}

/**
 * Returns true if the mission is blocked by an unmet dependency.
 * A mission is blocked when it has a dependsOnMissionId AND the gate
 * condition hasn't been cleared yet (dependencyMetAt is null).
 *
 * For 'completed' gate: also unblocked when upstream.status === 'completed'
 * even before dependencyMetAt is set (handles cases where webhook didn't fire).
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

  const upstream = await db.query.missions.findFirst({
    where: eq(missions.id, mission.dependsOnMissionId),
    columns: { id: true, title: true, status: true },
  });

  if (!upstream) {
    // Upstream deleted — unblock automatically
    return { blocked: false };
  }

  if (mission.gateCondition === 'completed') {
    if (upstream.status === 'completed') {
      return { blocked: false };
    }
    return {
      blocked: true,
      reason: `Waiting for mission "${upstream.title}" to complete`,
      dependsOnTitle: upstream.title,
      dependsOnMissionId: upstream.id,
    };
  }

  // 'merged' gate: only cleared when dependencyMetAt is set by the webhook
  return {
    blocked: true,
    reason: `Waiting for mission "${upstream.title}" PRs to merge`,
    dependsOnTitle: upstream.title,
    dependsOnMissionId: upstream.id,
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
      where: eq(missions.id, currentId),
      columns: { id: true, dependsOnMissionId: true },
    });

    if (!node) return false;
    if (node.dependsOnMissionId === missionId) return true;
    currentId = node.dependsOnMissionId;
  }

  return false;
}

/**
 * Does the upstream mission actually have nothing left to merge?
 *
 * The `merged` gate is worded "PRs to merge" — plural — and it means it. The
 * signal that drives it fires from a single PR's merge webhook, so on its own it
 * says only "one PR of this mission merged". Two things still count as
 * outstanding:
 *
 *  1. a worker holding an open PR (`prUrl` set, `mergedAt` null), and
 *  2. a non-terminal deliverable task, whose PR has not been opened yet.
 *
 * Bookkeeping rows are excluded: an aggregator or planning slot is not a
 * deliverable and must not hold a downstream mission behind it. Rows predating
 * the `taskClass` backfill (NULL) are counted, which errs toward staying
 * blocked — the safe direction for a gate.
 */
async function missionHasUnmergedWork(missionId: string): Promise<boolean> {
  const [openPrs] = await db
    .select({ count: count() })
    .from(workers)
    .innerJoin(tasks, eq(tasks.id, workers.taskId))
    .where(
      and(
        eq(tasks.missionId, missionId),
        isNotNull(workers.prUrl),
        isNull(workers.mergedAt),
      ),
    );
  if (Number(openPrs?.count ?? 0) > 0) return true;

  const [pendingWork] = await db
    .select({ count: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.missionId, missionId),
        inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
        or(isNull(tasks.taskClass), ne(tasks.taskClass, 'bookkeeping')),
      ),
    );
  return Number(pendingWork?.count ?? 0) > 0;
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
 * Returns the IDs of missions that were unblocked.
 */
export async function checkAndUnblockDependentMissions(
  upstreamMissionId: string,
  signal: 'completed' | 'merged',
): Promise<string[]> {
  const dependents = await db.query.missions.findMany({
    where: and(
      eq(missions.dependsOnMissionId, upstreamMissionId),
      isNull(missions.dependencyMetAt),
    ),
    columns: { id: true, gateCondition: true },
  });

  if (dependents.length === 0) return [];

  const toUnblock = dependents.filter(d => d.gateCondition === signal);
  if (toUnblock.length === 0) return [];

  // Checked only after we know a dependent is actually waiting on this signal,
  // so the common no-dependents case costs no extra queries.
  if (signal === 'merged' && await missionHasUnmergedWork(upstreamMissionId)) {
    return [];
  }

  const now = new Date();
  const unblockedIds: string[] = [];

  for (const dep of toUnblock) {
    await db
      .update(missions)
      .set({ dependencyMetAt: now, updatedAt: now })
      .where(and(eq(missions.id, dep.id), isNull(missions.dependencyMetAt)));
    unblockedIds.push(dep.id);
  }

  return unblockedIds;
}
