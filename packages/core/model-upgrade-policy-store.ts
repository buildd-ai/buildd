/**
 * Reads and writes the model-upgrade policy (model-upgrade-policy.ts) on
 * `teams.model_upgrade_policy` and `workspaces.model_upgrade_policy`.
 *
 * Reads are cached for 60s per (team, workspace), like the tier registry, and
 * fail open to the default policy: a DB hiccup must not change which model a
 * claim gets in a way the team did not choose, and latest-compatible is what
 * every team ran before policies existed.
 */
import { eq } from 'drizzle-orm';
import { db } from './db/client';
import { teams, workspaces } from './db/schema';
import {
  DEFAULT_MODEL_UPGRADE_POLICY,
  resolveUpgradePolicy,
  type EffectiveUpgradePolicy,
  type ModelUpgradePolicy,
} from './model-upgrade-policy';

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map<string, { value: EffectiveUpgradePolicy; loadedAt: number }>();

export function invalidateUpgradePolicyCache(): void {
  cache.clear();
}

/** The effective policy for a team (and optionally one of its workspaces), with its source. */
export async function loadUpgradePolicy(
  teamId: string | null,
  workspaceId: string | null | undefined,
): Promise<EffectiveUpgradePolicy> {
  const key = `${teamId ?? ''}:${workspaceId ?? ''}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.loadedAt < CACHE_TTL_MS) return hit.value;
  try {
    const [team, ws] = await Promise.all([
      teamId
        ? db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { modelUpgradePolicy: true } })
        : Promise.resolve(null),
      workspaceId
        ? db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { modelUpgradePolicy: true } })
        : Promise.resolve(null),
    ]);
    const value = resolveUpgradePolicy(team?.modelUpgradePolicy ?? null, ws?.modelUpgradePolicy ?? null);
    cache.set(key, { value, loadedAt: now });
    return value;
  } catch {
    return { policy: DEFAULT_MODEL_UPGRADE_POLICY, source: 'default' };
  }
}

/** The policy stored at exactly one level (no inheritance), or null. */
export async function readStoredUpgradePolicy(
  scope: { teamId: string } | { workspaceId: string },
): Promise<unknown> {
  if ('workspaceId' in scope) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, scope.workspaceId),
      columns: { modelUpgradePolicy: true },
    });
    return ws?.modelUpgradePolicy ?? null;
  }
  const team = await db.query.teams.findFirst({ where: eq(teams.id, scope.teamId), columns: { modelUpgradePolicy: true } });
  return team?.modelUpgradePolicy ?? null;
}

/** Store (or, with null, clear) the policy at one level. */
export async function writeUpgradePolicy(
  scope: { teamId: string } | { workspaceId: string },
  policy: ModelUpgradePolicy | null,
): Promise<void> {
  const now = new Date();
  if ('workspaceId' in scope) {
    await db.update(workspaces).set({ modelUpgradePolicy: policy, updatedAt: now }).where(eq(workspaces.id, scope.workspaceId));
  } else {
    await db.update(teams).set({ modelUpgradePolicy: policy, updatedAt: now }).where(eq(teams.id, scope.teamId));
  }
  invalidateUpgradePolicyCache();
}
