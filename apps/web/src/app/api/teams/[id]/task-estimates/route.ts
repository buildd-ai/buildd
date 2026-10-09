/**
 * GET /api/teams/[id]/task-estimates — the task-estimates model's live
 * readout, read-only (experiment; removal in packages/core/TASK-ESTIMATES-REMOVAL.md).
 *
 * → { enabled, estimatorVersion, readout, workspaces: [{ workspaceId, workspaceName, tasks, clusters }] }
 *
 * `readout` is how close the frozen estimates were to what finished tasks
 * actually took (packages/core/task-estimate-readout.ts: the backtest's scorer
 * over live rows, by source, kind, area cluster and workspace history size).
 * `workspaces` is how the model sees each repo: its area clusters with n and
 * quantiles, per workspace and never merged (a label is a path in one repo).
 * Labels are directory prefixes of the caller's own workspaces.
 *
 * Any member of the team, or an API key of that team: the same read access as
 * GET /api/teams/[id].
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { teamMembers, teams } from '@buildd/core/db/schema';
import { ESTIMATOR_VERSION } from '@buildd/core/task-estimate';
import { readTaskEstimatesSetting } from '@buildd/core/task-estimate-source';
import { loadTeamClusters, runTaskEstimateReadout } from '@buildd/core/task-estimate-accuracy-source';
import { getRequestPrincipal } from '@/lib/auth-helpers';
import { isUuid } from '@/lib/uuid';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid team id: expected a UUID, got "${id}".` }, { status: 404 });
  }
  const principal = await getRequestPrincipal(req);
  if (!principal) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    if (principal.kind === 'api_key') {
      if (principal.account.teamId !== id) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    } else {
      const membership = await db.query.teamMembers.findFirst({
        where: and(eq(teamMembers.teamId, id), eq(teamMembers.userId, principal.user.id)),
        columns: { role: true },
      });
      if (!membership) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    }

    const team = await db.query.teams.findFirst({ where: eq(teams.id, id), columns: { taskEstimates: true } });
    if (!team) return NextResponse.json({ error: 'Team not found' }, { status: 404 });

    const [readout, workspaces] = await Promise.all([runTaskEstimateReadout(id), loadTeamClusters(id)]);
    return NextResponse.json({
      enabled: readTaskEstimatesSetting(team.taskEstimates),
      estimatorVersion: ESTIMATOR_VERSION,
      readout,
      workspaces,
    });
  } catch (err) {
    console.error('[task-estimates] readout failed:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
