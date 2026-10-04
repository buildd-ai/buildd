import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { listBuilddDecisionKinds } from '@buildd/core/decision-kinds';
import { readDecisionKindReadout } from '@buildd/core/decision-readout-source';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveAccountTeamIds } from '@/lib/team-access';

const WINDOWS = { '24h': 1, '7d': 7, '30d': 30 } as const;
type Window = keyof typeof WINDOWS;
const KIND_RE = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/;

/**
 * Read-only: the shared readout for one decision kind in one workspace —
 * collection health first (disabled / misconfigured / not collecting /
 * insufficient sample / sufficient), then coverage, applied attempts,
 * challenger runs, failures, labelled outcomes, latency, cost, escalation
 * and, only for randomized rows, a causal comparison
 * (packages/core/decision-readout.ts). A kind defined in this process is read
 * with its binding; any other kind id is read from its rows alone.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const account = token ? await authenticateApiKey(token, req) : null;
  if (!user && !account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const workspaceId = params.get('workspaceId') ?? params.get('workspace');
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
  const kindId = params.get('kind');
  if (!kindId || !KIND_RE.test(kindId)) return NextResponse.json({ error: 'kind is required (e.g. buildd.decision_name)' }, { status: 400 });

  const teamIds = await resolveAccountTeamIds(user, account);
  const allowed = teamIds.length ? await db.query.workspaces.findMany({
    where: inArray(workspaces.teamId, teamIds), columns: { id: true, teamId: true },
  }) : [];
  const match = allowed.find(w => w.id === workspaceId);
  if (!match) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const windowParam = params.get('window') ?? '7d';
  if (!(windowParam in WINDOWS)) return NextResponse.json({ error: 'Invalid window' }, { status: 400 });
  const until = new Date();
  const since = new Date(until.getTime() - WINDOWS[windowParam as Window] * 86400000);

  const kind = listBuilddDecisionKinds().find(k => k.kind === kindId) ?? kindId;
  const result = await readDecisionKindReadout(kind, { teamId: match.teamId, workspaceId: match.id, since, until });
  return NextResponse.json(result);
}
