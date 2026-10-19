import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { scheduleMoves, taskSchedules, workspaces } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from '@/lib/team-access';
import { can } from '@/lib/permissions';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { applyScheduleMove, keepScheduleHome, validateScheduleMove } from '@/lib/schedule-move';
import { moverOf } from '@/lib/schedule-move-auth';

type RouteParams = { params: Promise<{ id: string; scheduleId: string; proposalId: string }> };

async function resolveAuth(req: NextRequest, workspaceId: string) {
  const user = await getCurrentUser();
  if (user && await verifyWorkspaceAccess(user.id, workspaceId)) return { kind: 'user' as const, userId: user.id as string };
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey, req);
  if (account && hasTokenRouteAdminAccess(account, req) && await verifyAccountWorkspaceAccess(account, workspaceId)) {
    return { kind: 'account' as const, accountId: account.id, teamId: account.teamId as string, level: account.level as string | null, account };
  }
  return null;
}

// POST { decision: 'accept' | 'keep', grantOldHome?: boolean } - answer an open
// move proposal. A person with delegate_schedule_access only; the move is
// validated again here against the person (AC-14), and takes effect from the
// next tick: the run in flight and tasks already filed keep their home.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id, scheduleId, proposalId } = await params;
  const auth = await resolveAuth(req, id);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const own = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, id)), columns: { teamId: true } });
  if (!own?.teamId) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  if (!(await can(auth, 'delegate_schedule_access', own.teamId))) {
    return NextResponse.json({ error: 'Answering a schedule move requires team admin or owner' }, { status: 403 });
  }

  const body = await req.json().catch(() => null) as { decision?: unknown; grantOldHome?: unknown } | null;
  const decision = body?.decision;
  if (decision !== 'accept' && decision !== 'keep') return NextResponse.json({ error: "decision must be 'accept' or 'keep'" }, { status: 400 });

  const [proposal] = await db.select().from(scheduleMoves)
    .where(and(eq(scheduleMoves.id, proposalId), eq(scheduleMoves.scheduleId, scheduleId))).limit(1);
  const schedule = await db.query.taskSchedules.findFirst({
    where: sqlWhere(and(eq(taskSchedules.id, scheduleId), eq(taskSchedules.workspaceId, id))),
  });
  if (!proposal || !schedule) return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
  if (proposal.status !== 'open') return NextResponse.json({ error: `This proposal was already answered (${proposal.status})`, status: proposal.status }, { status: 409 });

  const mover = moverOf(auth);
  if (decision === 'keep') {
    const kept = await keepScheduleHome(proposalId, mover.actor);
    if (!kept) return NextResponse.json({ error: 'This proposal was already answered' }, { status: 409 });
    return NextResponse.json({ proposal: kept, schedule });
  }

  const check = await validateScheduleMove({ fromWorkspaceId: id, targetWorkspaceId: proposal.toWorkspaceId, canCreateIn: mover.canCreateIn });
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });
  const moved = await applyScheduleMove({
    schedule, targetWorkspaceId: proposal.toWorkspaceId, actor: mover.actor,
    grantOldHome: body?.grantOldHome === true, reason: proposal.reason, proposalId,
  });
  if (!moved) return NextResponse.json({ error: 'The schedule was moved by someone else; reload it' }, { status: 409 });
  return NextResponse.json({ proposal: moved.move, schedule: moved.schedule });
}
