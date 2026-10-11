import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { authenticateTaskScopedCaller, taskScopeAllowsDelegated } from '@/lib/task-token-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { fetchCoordinationStats } from '@/lib/coordination-stats-query';
import { fetchOrchestrationDecisionStats } from '@/lib/orchestration-decision-stats-query';
import { fetchEarlyReleaseStats } from '@/lib/early-release-metrics';

/** Read-only aggregate coordination metrics, scoped to the caller's teams. */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  // A per-task token reads coordination stats for its own task's workspace,
  // plus any its schedule's delegation grants analytics:read on.
  const account = token ? await authenticateTaskScopedCaller(token, req) : null;
  if (!user && !account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const window = params.get('window') ?? '7d';
  if (!['24h', '7d', '30d'].includes(window)) return NextResponse.json({ error: 'Invalid window' }, { status: 400 });
  const missionId = params.get('missionId') ?? params.get('mission') ?? undefined;
  if (missionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(missionId)) {
    return NextResponse.json({ error: 'missionId must be a full UUID' }, { status: 400 });
  }
  const metric = params.get('metric');
  if (metric && !['manifest', 'pathClaims', 'orchestrationDecisions', 'earlyRelease'].includes(metric)) return NextResponse.json({ error: 'Invalid metric' }, { status: 400 });
  const teamIds = await resolveAccountTeamIds(user, account);
  const teamWorkspaces = teamIds.length ? await db.query.workspaces.findMany({
    where: inArray(workspaces.teamId, teamIds), columns: { id: true },
  }) : [];
  const allowed = account ? teamWorkspaces.filter(w => taskScopeAllowsDelegated(account, w.id, 'analytics:read')) : teamWorkspaces;
  const workspace = params.get('workspaceId') ?? params.get('workspace');
  if (workspace && !allowed.some(w => w.id === workspace)) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  const filters = {
    workspaceIds: workspace ? [workspace] : allowed.map(w => w.id),
    missionId,
    window: window as '24h' | '7d' | '30d',
  };
  // The decision ledger is its own read: never part of the unfiltered report.
  if (metric === 'orchestrationDecisions') return NextResponse.json(await fetchOrchestrationDecisionStats(filters));
  if (metric === 'earlyRelease') return NextResponse.json(await fetchEarlyReleaseStats(filters));
  if (metric) {
    const stats = await fetchCoordinationStats(filters);
    return NextResponse.json(metric === 'manifest' ? stats.manifestCoverage : stats.pathClaims);
  }
  const [stats, earlyRelease] = await Promise.all([fetchCoordinationStats(filters), fetchEarlyReleaseStats(filters)]);
  return NextResponse.json({ ...stats, earlyRelease });
}
