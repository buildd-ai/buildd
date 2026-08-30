import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { missions, workspaces, workers, tasks, releases, releaseTasks } from './db/schema';
import { detectArchetype } from './release-archetype';
import type { db as DbInstance } from './db';

type Db = typeof DbInstance;

/** Resolved metric value or a reason why it cannot be computed. */
export type MetricResult = { value: number } | { unavailable: string };

/**
 * Resolves a metric key to a numeric value for a given initiative.
 * Injected into evaluateInitiativeKPIs to keep that function pure/testable.
 */
export type MetricResolver = (key: string, initiativeId: string) => Promise<MetricResult>;

/** Known metric keys implemented in the default registry. */
export const KNOWN_METRIC_KEYS = new Set([
  'release.attribution_coverage_pct',
  'release.merge_to_healthy_p50_hours',
  'release.change_failure_rate_pct',
  'release.oldest_unshipped_age_days',
]);

// ─── Workspace resolution ─────────────────────────────────────────────────────

/**
 * Returns workspace IDs for an initiative's child missions that have
 * a non-'none' archetype (i.e. are release-tracking workspaces).
 */
async function resolveInitiativeWorkspaceIds(initiativeId: string, db: Db): Promise<string[]> {
  const missionRows = await db
    .select({ workspaceId: missions.workspaceId })
    .from(missions)
    .where(and(eq(missions.initiativeId, initiativeId), isNotNull(missions.workspaceId)));

  const wsIds = [...new Set(
    missionRows.map(r => r.workspaceId).filter((id): id is string => id != null),
  )];
  if (wsIds.length === 0) return [];

  const wsRows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      releaseConfig: workspaces.releaseConfig,
      gitConfig: workspaces.gitConfig,
    })
    .from(workspaces)
    .where(inArray(workspaces.id, wsIds));

  return wsRows
    .filter(ws => detectArchetype(ws) !== 'none')
    .map(ws => ws.id);
}

// ─── Metric implementations ───────────────────────────────────────────────────

/**
 * release.attribution_coverage_pct
 *
 * Share of merged tasks that appear in release_tasks.
 * Denominator is capped at the latest release's createdAt, so tasks merged
 * after the most recent release are legitimately unshipped — not uncovered.
 */
async function computeAttributionCoverage(wsIds: string[], db: Db): Promise<MetricResult> {
  // Find the latest release across these workspaces.
  const [latestRelRow] = await db
    .select({ maxCreatedAt: sql<string | null>`MAX(${releases.createdAt})::text` })
    .from(releases)
    .where(inArray(releases.workspaceId, wsIds));

  const latestRelCreatedAt = latestRelRow?.maxCreatedAt ?? null;
  if (!latestRelCreatedAt) {
    return { unavailable: 'no releases exist yet for this initiative' };
  }

  // All distinct task IDs from merged workers at or before the latest release.
  const mergedRows = await db
    .selectDistinct({ taskId: workers.taskId })
    .from(workers)
    .innerJoin(tasks, eq(tasks.id, workers.taskId))
    .where(and(
      inArray(tasks.workspaceId, wsIds),
      isNotNull(workers.taskId),
      isNotNull(workers.mergedAt),
      sql`${workers.mergedAt} <= ${latestRelCreatedAt}::timestamptz`,
    ));

  const totalTaskIds = mergedRows.map(r => r.taskId).filter((id): id is string => id != null);
  if (totalTaskIds.length === 0) return { value: 100 };

  // How many of those task IDs appear in release_tasks?
  const attributedRows = await db
    .selectDistinct({ taskId: releaseTasks.taskId })
    .from(releaseTasks)
    .where(inArray(releaseTasks.taskId, totalTaskIds));

  const value = (attributedRows.length / totalTaskIds.length) * 100;
  return { value };
}

/**
 * release.merge_to_healthy_p50_hours
 *
 * Median hours from workers.merged_at to releases.healthy_at for attributed tasks.
 * UNVERIFIED until releases have healthy_at populated.
 */
async function computeMergeToHealthyP50(wsIds: string[], db: Db): Promise<MetricResult> {
  const [p50Row] = await db
    .select({
      p50: sql<number | null>`
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (${releases.healthyAt} - ${workers.mergedAt})) / 3600
        )
      `.mapWith(Number),
    })
    .from(releaseTasks)
    .innerJoin(releases, eq(releases.id, releaseTasks.releaseId))
    .innerJoin(workers, eq(workers.taskId, releaseTasks.taskId))
    .where(and(
      inArray(releases.workspaceId, wsIds),
      isNotNull(releases.healthyAt),
      isNotNull(workers.mergedAt),
    ));

  if (p50Row?.p50 == null) {
    return { unavailable: 'no releases with healthy_at — deploy health tracking not yet active' };
  }
  return { value: p50Row.p50 };
}

/**
 * release.change_failure_rate_pct
 *
 * Percentage of resolved releases that ended in failed or degraded state.
 * UNVERIFIED if there are no resolved releases (dispatched/deploying/pending_external are in-flight).
 */
async function computeChangeFailureRate(wsIds: string[], db: Db): Promise<MetricResult> {
  const [statsRow] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      failed: sql<number>`COUNT(*) FILTER (WHERE ${releases.state} IN ('failed', 'degraded'))::int`,
    })
    .from(releases)
    .where(and(
      inArray(releases.workspaceId, wsIds),
      sql`${releases.state} NOT IN ('dispatched', 'deploying', 'pending_external')`,
    ));

  const total = statsRow?.total ?? 0;
  if (total === 0) {
    return { unavailable: 'no resolved releases — change failure rate not yet computable' };
  }
  return { value: ((statsRow?.failed ?? 0) / total) * 100 };
}

/**
 * release.oldest_unshipped_age_days
 *
 * Age in days of the oldest merged worker whose mergedAt is after the most
 * recent healthy release (i.e. not yet shipped to production).
 * Reuses the same baseline logic as the mission-footer release queue widget.
 */
async function computeOldestUnshippedAge(wsIds: string[], db: Db, now: Date): Promise<MetricResult> {
  // Find the healthy baseline for these workspaces.
  const [healthyRow] = await db
    .select({ maxHealthyAt: sql<string | null>`MAX(${releases.healthyAt})::text` })
    .from(releases)
    .where(and(
      inArray(releases.workspaceId, wsIds),
      eq(releases.state, 'healthy'),
    ));

  const maxHealthyAt = healthyRow?.maxHealthyAt ?? null;
  if (!maxHealthyAt) {
    return { unavailable: 'no healthy release baseline — cannot determine unshipped queue' };
  }

  // Oldest worker merged after that baseline.
  const [oldestRow] = await db
    .select({ oldestMergedAt: sql<string | null>`MIN(${workers.mergedAt})::text` })
    .from(workers)
    .innerJoin(tasks, eq(tasks.id, workers.taskId))
    .where(and(
      inArray(tasks.workspaceId, wsIds),
      isNotNull(workers.mergedAt),
      sql`${workers.mergedAt} > ${maxHealthyAt}::timestamptz`,
    ));

  const oldestMergedAt = oldestRow?.oldestMergedAt ?? null;
  if (!oldestMergedAt) return { value: 0 };

  const ageMs = now.getTime() - new Date(oldestMergedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return { value: ageDays };
}

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Build the default DB-backed MetricResolver for an initiative.
 * Workspace IDs are resolved once per initiative ID and memoized for the
 * duration of the resolver's lifetime (one evaluation call).
 */
export function buildDefaultResolver(db: Db, now?: Date): MetricResolver {
  const nowDate = now ?? new Date();
  const wsIdCache = new Map<string, Promise<string[]>>();

  function getWorkspaceIds(initiativeId: string): Promise<string[]> {
    if (!wsIdCache.has(initiativeId)) {
      wsIdCache.set(initiativeId, resolveInitiativeWorkspaceIds(initiativeId, db));
    }
    return wsIdCache.get(initiativeId)!;
  }

  return async (key: string, initiativeId: string): Promise<MetricResult> => {
    if (!KNOWN_METRIC_KEYS.has(key)) {
      return { unavailable: `unknown metric: ${key}` };
    }

    const wsIds = await getWorkspaceIds(initiativeId);
    if (wsIds.length === 0) {
      return { unavailable: 'no participating workspaces with release tracking' };
    }

    switch (key) {
      case 'release.attribution_coverage_pct':
        return computeAttributionCoverage(wsIds, db);
      case 'release.merge_to_healthy_p50_hours':
        return computeMergeToHealthyP50(wsIds, db);
      case 'release.change_failure_rate_pct':
        return computeChangeFailureRate(wsIds, db);
      case 'release.oldest_unshipped_age_days':
        return computeOldestUnshippedAge(wsIds, db, nowDate);
      default:
        return { unavailable: `unknown metric: ${key}` };
    }
  };
}
