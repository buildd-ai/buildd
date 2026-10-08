import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { readDecisionLedgerPage, summarizeDecisionLedger } from '@buildd/core/decision-ledger';
import { authenticateTaskScopedCaller, taskScopeAllowsDelegated } from '@/lib/task-token-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveAccountTeamIds } from '@/lib/team-access';

const WINDOWS = { '24h': 1, '7d': 7, '30d': 30 } as const;
type Window = keyof typeof WINDOWS;
/** An explicit since/until window may span at most this many days. */
const MAX_EXPLICIT_WINDOW_DAYS = 31;

function parseInstant(value: string | null): Date | null | 'invalid' {
  if (value === null) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'invalid' : d;
}

/**
 * Read-only: every decision-call record for one workspace's team, newest
 * first (knowledge-base: buildd/design/decision-calls.md "The decision
 * ledger"). The weekly review run pulls a window of decisions with one call
 * here instead of grepping shadow log lines.
 *
 * A per-task token reads its own task's workspace, or one its schedule's
 * delegation grants analytics:read on (packages/core/token-delegation.ts).
 *
 * The answer always carries `status`: OK when rows matched, NO_DATA when the
 * read succeeded and nothing matched. A store failure is a 503, never an
 * empty page, so a reviewer cannot mistake "could not read" for "nothing
 * happened". `since`/`until` (ISO) pin a stable window (a prior UTC week)
 * instead of the rolling `window`; `truncated` + `nextUntil` continue a page.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const account = token ? await authenticateTaskScopedCaller(token, req) : null;
  if (!user && !account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const workspaceId = params.get('workspaceId') ?? params.get('workspace');
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });

  const teamIds = await resolveAccountTeamIds(user, account);
  const teamWorkspaces = teamIds.length ? await db.query.workspaces.findMany({
    where: inArray(workspaces.teamId, teamIds), columns: { id: true, teamId: true },
  }) : [];
  const allowed = account ? teamWorkspaces.filter(w => taskScopeAllowsDelegated(account, w.id, 'analytics:read')) : teamWorkspaces;
  const match = allowed.find(w => w.id === workspaceId);
  if (!match) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const windowParam = params.get('window') ?? '7d';
  if (!(windowParam in WINDOWS)) return NextResponse.json({ error: 'Invalid window' }, { status: 400 });
  const sinceParam = parseInstant(params.get('since'));
  const untilParam = parseInstant(params.get('until'));
  if (sinceParam === 'invalid' || untilParam === 'invalid') {
    return NextResponse.json({ error: 'since and until must be ISO timestamps' }, { status: 400 });
  }
  const until = untilParam ?? undefined;
  const since = sinceParam ?? new Date((until?.getTime() ?? Date.now()) - WINDOWS[windowParam as Window] * 86400000);
  if (until && since >= until) return NextResponse.json({ error: 'since must be before until' }, { status: 400 });
  if (((until?.getTime() ?? Date.now()) - since.getTime()) > MAX_EXPLICIT_WINDOW_DAYS * 86400000) {
    return NextResponse.json({ error: `the window may span at most ${MAX_EXPLICIT_WINDOW_DAYS} days` }, { status: 400 });
  }

  const capability = params.get('capability') ?? undefined;
  const disagreementOnly = params.get('disagreementOnly') === 'true';
  const overriddenOnly = params.get('overriddenOnly') === 'true';
  const limitParam = params.get('limit');
  const limit = limitParam ? Math.max(1, Math.min(500, Number.parseInt(limitParam, 10) || 0)) : undefined;

  let page: Awaited<ReturnType<typeof readDecisionLedgerPage>>;
  try {
    page = await readDecisionLedgerPage({
      teamId: match.teamId,
      workspaceId: match.id,
      capability,
      since,
      until,
      disagreementOnly,
      overriddenOnly,
    }, limit);
  } catch (err) {
    console.error('[decisions] ledger read failed:', (err as Error)?.message ?? err);
    return NextResponse.json({ status: 'TOOL_UNAVAILABLE', error: 'The decision ledger could not be read. This is not an empty result.' }, { status: 503 });
  }

  const outcomesById = new Map<string, typeof page.outcomes>();
  for (const o of page.outcomes) {
    const list = outcomesById.get(o.decisionRecordId) ?? [];
    list.push(o);
    outcomesById.set(o.decisionRecordId, list);
  }
  const decisions = page.rows.map(r => ({ ...r, outcomes: outcomesById.get(r.id) ?? [] }));
  const oldest = page.rows[page.rows.length - 1]?.createdAt;

  return NextResponse.json({
    status: decisions.length ? 'OK' : 'NO_DATA',
    workspaceId: match.id,
    window: sinceParam || untilParam ? 'explicit' : windowParam,
    since: since.toISOString(),
    until: (until ?? new Date()).toISOString(),
    capability: capability ?? null,
    count: decisions.length,
    truncated: page.truncated,
    nextUntil: page.truncated && oldest ? new Date(oldest).toISOString() : null,
    summary: summarizeDecisionLedger(page.rows, page.outcomes.length),
    decisions,
  });
}
