import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import { eq, and, isNull } from 'drizzle-orm';

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
 * Called when an upstream mission satisfies the gate condition.
 * Finds all blocked dependents with a matching gateCondition and sets
 * their dependencyMetAt, releasing the block.
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
