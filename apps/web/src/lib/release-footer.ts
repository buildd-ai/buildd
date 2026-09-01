// The ONE loader for per-workspace release-footer data. Missions list
// (mission-card footer) and mission detail (MissionReleaseSection) both call
// this so they cannot disagree about queue depth or last-deploy state — the
// data is scoped to the workspace, not the mission, because a workspace's
// release ledger is shared by every mission under it (spec §8.5, AC-41).
import { db } from '@buildd/core/db';
import { releases, workers, tasks as tasksTable } from '@buildd/core/db/schema';
import { desc, eq, and, isNotNull, sql } from 'drizzle-orm';
import { detectArchetype } from '@buildd/core/release-archetype';
import { derivedValue, derivedUnavailable } from '@buildd/core/derived-metric';
import type { ReleaseFooterData } from '@/components/MissionReleaseFooter';
import { resolveGatedReleaseBaseline } from '@/lib/release-baseline';

export interface ReleaseFooterWorkspace {
  id: string;
  name: string | null;
  gitConfig: unknown;
  releaseConfig: unknown;
}

export async function loadReleaseFooterData(workspace: ReleaseFooterWorkspace): Promise<ReleaseFooterData> {
  const archetype = detectArchetype({
    name: workspace.name,
    releaseConfig: (workspace.releaseConfig as any) ?? null,
    gitConfig: (workspace.gitConfig as any) ?? null,
  });

  if (archetype === 'gated') {
    const [latestRelRow] = await db
      .select({ id: releases.id })
      .from(releases)
      .where(eq(releases.workspaceId, workspace.id))
      .orderBy(desc(releases.createdAt))
      .limit(1);

    // Baseline ladder (@buildd/core/release-baseline via resolveGatedReleaseBaseline):
    // healthy release → deployed release → any release row → prod-branch HEAD.
    const baseline = await resolveGatedReleaseBaseline(workspace.id);

    const queueRow = baseline.asOf
      ? (await db
          .select({
            queueDepth: sql<number>`count(*)::int`,
            oldestMergedAt: sql<string | null>`min(${workers.mergedAt})::text`,
          })
          .from(workers)
          .innerJoin(tasksTable, eq(tasksTable.id, workers.taskId))
          .where(and(
            eq(tasksTable.workspaceId, workspace.id),
            isNotNull(workers.mergedAt),
            sql`${workers.mergedAt} > ${baseline.asOf}::timestamptz`,
          )))[0]
      : undefined;

    return {
      archetype: 'gated',
      queueDepth: baseline.asOf ? derivedValue(queueRow?.queueDepth ?? 0) : derivedUnavailable<number>('no_baseline'),
      oldestMergedAt:
        baseline.asOf && queueRow?.oldestMergedAt
          ? derivedValue(queueRow.oldestMergedAt)
          : derivedUnavailable<string>('no_scope'),
      baselineSource: baseline.source,
      releaseId: latestRelRow?.id ?? null,
    };
  }

  if (archetype === 'continuous') {
    const [lastRelease] = await db
      .select({
        id: releases.id,
        state: releases.state,
        deployedAt: sql<string | null>`deployed_at::text`,
        healthyAt: sql<string | null>`healthy_at::text`,
      })
      .from(releases)
      .where(eq(releases.workspaceId, workspace.id))
      .orderBy(desc(releases.createdAt))
      .limit(1);

    return lastRelease
      ? {
          archetype: 'continuous',
          state: lastRelease.state,
          deployedAt: lastRelease.deployedAt ?? null,
          healthyAt: lastRelease.healthyAt ?? null,
          releaseId: lastRelease.id,
        }
      : null;
  }

  return null;
}
