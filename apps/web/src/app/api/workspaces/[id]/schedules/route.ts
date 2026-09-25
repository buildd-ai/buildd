import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { taskSchedules, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { validateCronExpression, computeNextRunAt } from '@/lib/schedule-helpers';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { getWorkspaceTimezone } from '@/lib/team-timezone';

type AuthOk = { ok: true; userId?: string; accountId?: string };
// status 401 = no valid principal at all (missing/invalid key, no session) — a
// real auth failure. status 403 = a real principal was authenticated but this
// workspace isn't in its scope — distinct from an expired/revoked key so a
// caller doesn't misread "wrong workspace" as "rotate your token".
type AuthFail = { ok: false; status: 401 | 403 };

/**
 * Authenticate via session or API key.
 *
 * Mutating ops (POST/PATCH/DELETE) require admin-level account.
 * Read ops (GET) accept any authenticated account in the workspace —
 * worker and trigger tokens need visibility for routine discovery via MCP.
 */
async function resolveAuth(
  req: NextRequest,
  workspaceId: string,
  { requireAdmin = true }: { requireAdmin?: boolean } = {}
): Promise<AuthOk | AuthFail> {
  let authenticatedButOutOfScope = false;

  // Try session auth first (session users have full access)
  const user = await getCurrentUser();
  if (user) {
    const access = await verifyWorkspaceAccess(user.id, workspaceId);
    if (access) return { ok: true, userId: user.id };
    authenticatedButOutOfScope = true;
  }

  // Try API key auth
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);
  if (account) {
    if (requireAdmin && account.level !== 'admin') return { ok: false, status: 403 };
    const hasAccess = await verifyAccountWorkspaceAccess(account.id, workspaceId);
    if (hasAccess) return { ok: true, accountId: account.id };
    authenticatedButOutOfScope = true;
  }

  return { ok: false, status: authenticatedButOutOfScope ? 403 : 401 };
}

function authFailureResponse(authResult: AuthFail, workspaceId: string) {
  if (authResult.status === 403) {
    return NextResponse.json(
      { error: 'forbidden', reason: 'This account does not have access to the requested workspace.', workspaceId },
      { status: 403 }
    );
  }
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

// GET /api/workspaces/[id]/schedules - List schedules for a workspace
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authResult = await resolveAuth(req, id, { requireAdmin: false });
  if (!authResult.ok) {
    return authFailureResponse(authResult, id);
  }

  const schedules = await db.query.taskSchedules.findMany({
    where: eq(taskSchedules.workspaceId, id),
    orderBy: (s, { desc }) => [desc(s.createdAt)],
  });

  return NextResponse.json({ schedules });
}

// POST /api/workspaces/[id]/schedules - Create a new schedule
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authResult = await resolveAuth(req, id);
  if (!authResult.ok) {
    return authFailureResponse(authResult, id);
  }

  try {
    const body = await req.json();
    const {
      name,
      cronExpression,
      timezone: requestedTimezone,
      taskTemplate,
      enabled = true,
      oneShot = false,
      maxConcurrentFromSchedule = 1,
      pauseAfterFailures = 5,
    } = body;

    if (!name || !cronExpression || !taskTemplate?.title) {
      return NextResponse.json(
        { error: 'name, cronExpression, and taskTemplate.title are required' },
        { status: 400 }
      );
    }

    // Validate cron expression
    const cronError = validateCronExpression(cronExpression);
    if (cronError) {
      return NextResponse.json({ error: `Invalid cron expression: ${cronError}` }, { status: 400 });
    }

    // An omitted timezone means "the team's zone", not UTC. Schedules created
    // through the API or by an agent otherwise silently run on a wall clock
    // nobody on the team uses. The dashboard always sends an explicit zone.
    const timezone = requestedTimezone ?? (await getWorkspaceTimezone(id));

    // Compute next run time
    const nextRunAt = enabled ? computeNextRunAt(cronExpression, timezone) : null;

    const [schedule] = await db
      .insert(taskSchedules)
      .values({
        workspaceId: id,
        name,
        cronExpression,
        timezone,
        taskTemplate,
        enabled,
        oneShot,
        nextRunAt,
        maxConcurrentFromSchedule,
        pauseAfterFailures,
        createdByUserId: authResult.userId || null,
      })
      .returning();

    return NextResponse.json({ schedule }, { status: 201 });
  } catch (error) {
    console.error('Create schedule error:', error);
    return NextResponse.json({ error: 'Failed to create schedule' }, { status: 500 });
  }
}
