import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, missionNotes } from '@buildd/core/db/schema';
import { eq, and, gte, count } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateTaskScopedCaller, isOrchestrationTaskToken, taskScopeAllowsMission } from '@/lib/task-token-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { evaluateCriteriaNow, ON_DEMAND_NOTE_TITLE } from '@/lib/mission-criteria-eval';
import { completeMissionIfVerified } from '@/lib/mission-completion';
import { isUuid } from '@/lib/uuid';
import { workspaceOpenToCaller } from '@/lib/open-workspaces';

const RATE_LIMIT_PER_HOUR = 6;

async function hasMissionAccess(mission: { teamId: string; workspaceId: string | null }, teamIds: string[], accountId?: string | null): Promise<boolean> {
  if (teamIds.includes(mission.teamId)) return true;
  if (mission.workspaceId) {
    if (await workspaceOpenToCaller(mission.workspaceId, { teamIds, accountId })) return true;
  }
  return false;
}

/**
 * POST /api/missions/[id]/evaluate
 *
 * On-demand evaluation of a mission's goalCriteria. Returns GoalCriteriaState
 * with per-criterion verdicts. Rate limited to 6 calls per mission per hour.
 *
 * The evaluation itself lives in `evaluateCriteriaNow` — the same code the
 * automatic path runs, so a human pressing "Run verification" and the heartbeat
 * asking for a verdict cannot get different answers. This route adds only auth,
 * the rate limit, and the completion attempt afterwards.
 *
 * Criteria are evaluated by kind, never all by prose:
 * - structural (`artifact_exists`, `no_open_tasks`, `all_prs_merged`) from DB state
 * - `command` by dispatching a verification task that RUNS the command
 * - `description` by an LLM reading task summaries and artifact content
 * - `metric` not yet implemented, so it stays UNVERIFIED and blocks completion
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid mission id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // An orchestration task's admin per-task token may evaluate its own task's
  // mission; hasTokenRouteAdminAccess is false for any task token.
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (apiAccount?.taskScope) {
    if (!isOrchestrationTaskToken(apiAccount) || !(await taskScopeAllowsMission(apiAccount, id))) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }
  } else if (apiAccount && !hasTokenRouteAdminAccess(apiAccount, req)) {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);

    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, id),
      columns: { id: true, teamId: true, workspaceId: true, goalCriteria: true },
    });

    if (!mission || !(await hasMissionAccess(mission, teamIds, apiAccount?.id))) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }

    const criteria = (mission.goalCriteria as unknown[]) ?? [];
    if (criteria.length === 0) {
      return NextResponse.json({
        message: 'No goalCriteria set — nothing to evaluate',
        goalCriteriaState: null,
      });
    }

    // Rate limit: max RATE_LIMIT_PER_HOUR on-demand evaluations per mission per hour.
    // Counted from the on-demand note title, which is why evaluateCriteriaNow
    // always writes that note for manual/mcp runs.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const [{ value: recentCount }] = await db
      .select({ value: count() })
      .from(missionNotes)
      .where(
        and(
          eq(missionNotes.missionId, id),
          eq(missionNotes.title, ON_DEMAND_NOTE_TITLE),
          gte(missionNotes.createdAt, oneHourAgo),
        )
      );

    if (Number(recentCount) >= RATE_LIMIT_PER_HOUR) {
      return NextResponse.json(
        { error: `Rate limit: max ${RATE_LIMIT_PER_HOUR} on-demand evaluations per mission per hour` },
        { status: 429 }
      );
    }

    const state = await evaluateCriteriaNow(id, {
      evaluatedBy: apiAccount ? 'mcp' : 'manual',
      noteTitle: ON_DEMAND_NOTE_TITLE,
      allowWorkerDispatch: true,
    });

    // A fresh pass may be the last thing the mission was waiting for. Reuse the
    // verdict just written rather than evaluating again.
    const completion = await completeMissionIfVerified(id, {
      path: 'criteria_eval',
      predicate: 'on-demand criteria evaluation',
      evaluateCriteria: false,
    });

    return NextResponse.json({
      goalCriteriaState: state,
      missionCompleted: completion.completed,
      completionBlockedBy: completion.completed ? null : completion.decision.code,
      completionReason: completion.decision.reason,
    });
  } catch (error) {
    console.error('Evaluate mission criteria error:', error);
    return NextResponse.json({ error: 'Failed to evaluate goal criteria' }, { status: 500 });
  }
}

/**
 * GET /api/missions/[id]/evaluate
 *
 * Returns the last GoalCriteriaState without re-evaluating (get_criteria_state).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid mission id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token reads only its own task's mission, as an orchestration run.
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (apiAccount?.taskScope && (!isOrchestrationTaskToken(apiAccount) || !(await taskScopeAllowsMission(apiAccount, id)))) {
    return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
  }

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);

    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, id),
      columns: { id: true, teamId: true, workspaceId: true, goalCriteria: true, goalCriteriaState: true },
    });

    if (!mission || !(await hasMissionAccess(mission, teamIds, apiAccount?.id))) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }

    return NextResponse.json({
      goalCriteria: mission.goalCriteria ?? null,
      goalCriteriaState: mission.goalCriteriaState ?? null,
    });
  } catch (error) {
    console.error('Get mission criteria state error:', error);
    return NextResponse.json({ error: 'Failed to get criteria state' }, { status: 500 });
  }
}
