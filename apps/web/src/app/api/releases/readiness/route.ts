import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { db } from '@buildd/core/db';
import { releases, workers, tasks, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull, sql, desc } from 'drizzle-orm';
import { getUserWorkspaceIds } from '@/lib/team-access';
import { detectArchetype } from '@buildd/core/release-archetype';
import type { CiState, ReleaseReadinessItem } from '@/lib/release-readiness';

/**
 * Release readiness per gated workspace — applies spec §8 exception-rule data.
 *
 * Returns queue depth (PRs merged since last healthy release) and CI state
 * (from the most recent releases row's ciStateAtDispatch) for each gated
 * workspace the caller can access.
 *
 * Query: ?workspaceIds=id1,id2   (optional; defaults to all accessible workspaces for session auth)
 * Auth: session user OR API key
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  let accessibleWsIds: string[] | null = null;

  if (apiKey) {
    const account = await authenticateApiKey(apiKey);
    if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // API key auth: caller must supply workspaceIds
  } else {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    accessibleWsIds = await getUserWorkspaceIds(user.id);
  }

  const sp = req.nextUrl.searchParams;
  const wsFilter = sp.get('workspaceIds')?.split(',').filter(Boolean) ?? null;

  let wsIds: string[];
  if (wsFilter) {
    wsIds = accessibleWsIds ? wsFilter.filter((id) => accessibleWsIds!.includes(id)) : wsFilter;
  } else {
    if (!accessibleWsIds) {
      return NextResponse.json({ error: 'workspaceIds required when using API key auth' }, { status: 400 });
    }
    wsIds = accessibleWsIds;
  }

  if (wsIds.length === 0) return NextResponse.json({ items: [] });

  const wsRows = await db
    .select({ id: workspaces.id, name: workspaces.name, releaseConfig: workspaces.releaseConfig, gitConfig: workspaces.gitConfig })
    .from(workspaces)
    .where(inArray(workspaces.id, wsIds));

  const gatedWsIds = wsRows
    .filter(
      (ws) =>
        detectArchetype({
          name: ws.name,
          releaseConfig: ws.releaseConfig as any,
          gitConfig: ws.gitConfig as any,
        }) === 'gated',
    )
    .map((ws) => ws.id);

  if (gatedWsIds.length === 0) return NextResponse.json({ items: [] });

  const items: ReleaseReadinessItem[] = await Promise.all(
    gatedWsIds.map(async (wsId) => {
      const ws = wsRows.find((w) => w.id === wsId)!;

      const [queueRow] = await db
        .select({
          queueDepth: sql<number>`count(*)::int`,
          oldestMergedAt: sql<string | null>`min(${workers.mergedAt})::text`,
        })
        .from(workers)
        .innerJoin(tasks, eq(tasks.id, workers.taskId))
        .where(
          and(
            eq(tasks.workspaceId, wsId),
            isNotNull(workers.mergedAt),
            sql`${workers.mergedAt} > COALESCE(
              (SELECT MAX(healthy_at) FROM releases WHERE workspace_id = ${wsId}::uuid AND state = 'healthy'),
              '1970-01-01'::timestamptz
            )`,
          ),
        );

      const [latestRelease] = await db
        .select({ ciStateAtDispatch: releases.ciStateAtDispatch })
        .from(releases)
        .where(eq(releases.workspaceId, wsId))
        .orderBy(desc(releases.createdAt))
        .limit(1);

      const ciState: CiState = (latestRelease?.ciStateAtDispatch as CiState) ?? 'unknown';

      return {
        workspaceId: wsId,
        workspaceName: ws.name,
        queueDepth: queueRow?.queueDepth ?? 0,
        oldestMergedAt: queueRow?.oldestMergedAt ?? null,
        ciState,
      };
    }),
  );

  return NextResponse.json({ items });
}
