import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workerHeartbeats, accountWorkspaces, workers } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserWorkspaceIds } from '@/lib/team-access';

const ALLOWED_PATHS = ['doctor', 'history/stats', 'debug/claims'] as const;
type AllowedPath = typeof ALLOWED_PATHS[number];

function isAllowedPath(path: string | null): path is AllowedPath {
  return ALLOWED_PATHS.includes(path as AllowedPath);
}

async function canAccessRunner(
  userId: string,
  heartbeatAccountId: string,
  heartbeatAccountTeamId: string | null,
): Promise<boolean> {
  const teamIds = await getUserTeamIds(userId);
  if (heartbeatAccountTeamId && teamIds.includes(heartbeatAccountTeamId)) return true;

  const wsIds = await getUserWorkspaceIds(userId);
  if (wsIds.length === 0) return false;

  const [linked, worked] = await Promise.all([
    db
      .selectDistinct({ accountId: accountWorkspaces.accountId })
      .from(accountWorkspaces)
      .where(
        and(
          eq(accountWorkspaces.accountId, heartbeatAccountId),
          inArray(accountWorkspaces.workspaceId, wsIds),
        ),
      ),
    db
      .selectDistinct({ accountId: workers.accountId })
      .from(workers)
      .where(
        and(
          eq(workers.accountId, heartbeatAccountId),
          inArray(workers.workspaceId, wsIds),
        ),
      ),
  ]);

  return linked.length > 0 || worked.length > 0;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ heartbeatId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const path = req.nextUrl.searchParams.get('path');
  if (!isAllowedPath(path)) {
    return NextResponse.json(
      { error: `Invalid path. Allowed: ${ALLOWED_PATHS.join(', ')}` },
      { status: 400 },
    );
  }

  const { heartbeatId } = await params;
  const hb = await db.query.workerHeartbeats.findFirst({
    where: eq(workerHeartbeats.id, heartbeatId),
    with: { account: { columns: { teamId: true } } },
  });
  if (!hb) return NextResponse.json({ error: 'Runner not found' }, { status: 404 });

  const accessible = await canAccessRunner(
    user.id,
    hb.accountId,
    (hb as any).account?.teamId ?? null,
  );
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
