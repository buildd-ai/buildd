import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { queryDecisionLedger } from '@buildd/core/decision-ledger';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveAccountTeamIds } from '@/lib/team-access';

const WINDOWS = { '24h': 1, '7d': 7, '30d': 30 } as const;
type Window = keyof typeof WINDOWS;

/**
 * Read-only: every decision-call record for one workspace's team, newest
 * first (knowledge-base: buildd/design/decision-calls.md "The decision
 * ledger"). The weekly review run pulls a window of decisions with one call
 * here instead of grepping shadow log lines.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const account = token ? await authenticateApiKey(token, req) : null;
  if (!user && !account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const workspaceId = params.get('workspaceId') ?? params.get('workspace');
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });

  const teamIds = await resolveAccountTeamIds(user, account);
  const allowed = teamIds.length ? await db.query.workspaces.findMany({
    where: inArray(workspaces.teamId, teamIds), columns: { id: true, teamId: true },
  }) : [];
  const match = allowed.find(w => w.id === workspaceId);
  if (!match) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const windowParam = params.get('window') ?? '7d';
  if (!(windowParam in WINDOWS)) return NextResponse.json({ error: 'Invalid window' }, { status: 400 });
  const since = new Date(Date.now() - WINDOWS[windowParam as Window] * 86400000);

  const capability = params.get('capability') ?? undefined;
  const disagreementOnly = params.get('disagreementOnly') === 'true';
  const overriddenOnly = params.get('overriddenOnly') === 'true';
  const limitParam = params.get('limit');
  const limit = limitParam ? Math.max(1, Math.min(500, Number.parseInt(limitParam, 10) || 0)) : undefined;

  const rows = await queryDecisionLedger({
    teamId: match.teamId,
    workspaceId: match.id,
    capability,
    since,
    disagreementOnly,
    overriddenOnly,
  }, limit);

  return NextResponse.json({ window: windowParam, since: since.toISOString(), capability: capability ?? null, count: rows.length, decisions: rows });
}
