import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workerHeartbeats } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { sqlWhere } from '@buildd/core/db/relational-sql';

const ALLOWED_PATHS = ['doctor', 'history/stats', 'debug/claims'] as const;
type AllowedPath = typeof ALLOWED_PATHS[number];

function isAllowedPath(path: string | null): path is AllowedPath {
  return ALLOWED_PATHS.includes(path as AllowedPath);
}

/**
 * Every allowed path is unscoped: the runner answers for all of its work
 * (lifetime sessions, cost, duration, claims), not for one team's. A runner
 * shared into other teams by a workspace link or past work is therefore NOT
 * enough; only a member of the runner account's own team may read it.
 */
async function canAccessRunner(
  userId: string,
  heartbeatAccountTeamId: string | null,
): Promise<boolean> {
  if (!heartbeatAccountTeamId) return false;
  const teamIds = await getUserTeamIds(userId);
  return teamIds.includes(heartbeatAccountTeamId);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ heartbeatId: string }> },
) {
  const { heartbeatId } = await params;
  if (!isUuid(heartbeatId)) {
    return NextResponse.json({ error: `Invalid heartbeat id: expected a UUID, got "${heartbeatId}".` }, { status: 404 });
  }

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const path = req.nextUrl.searchParams.get('path');
  if (!isAllowedPath(path)) {
    return NextResponse.json(
      { error: `Invalid path. Allowed: ${ALLOWED_PATHS.join(', ')}` },
      { status: 400 },
    );
  }

  const hb = await db.query.workerHeartbeats.findFirst({
    where: sqlWhere(eq(workerHeartbeats.id, heartbeatId)),
    with: { account: { columns: { teamId: true, createdByUserId: true } } },
  });
  if (!hb) return NextResponse.json({ error: 'Runner not found' }, { status: 404 });

  // Runner-local history spans every team and workspace. Team membership
  // cannot authorize lifetime totals, including for service-owned accounts.
  if (path === 'history/stats' && hb.account?.createdByUserId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const accessible = await canAccessRunner(user.id, (hb as any).account?.teamId ?? null);
  if (!accessible) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const runnerUrl = `${hb.localUiUrl}/api/${path}`;
  try {
    const runnerRes = await fetch(runnerUrl, {
      headers: hb.viewerToken ? { Authorization: `Bearer ${hb.viewerToken}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!runnerRes.ok) {
      return NextResponse.json(
        { error: 'Runner returned an error', runnerStatus: runnerRes.status },
        { status: 502 },
      );
    }
    const data = await runnerRes.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: 'Runner unreachable', detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
