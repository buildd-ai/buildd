import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, tasks, workers, artifacts, missionNotes, workspaces } from '@buildd/core/db/schema';
import { eq, and, gte, count, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { evaluateGoalCriteria } from '@buildd/core/mission-helpers';

const RATE_LIMIT_PER_HOUR = 6;

async function hasMissionAccess(mission: { teamId: string; workspaceId: string | null }, teamIds: string[]): Promise<boolean> {
  if (teamIds.includes(mission.teamId)) return true;
  if (mission.workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, mission.workspaceId),
      columns: { accessMode: true },
    });
    if (ws?.accessMode === 'open') return true;
  }
  return false;
}

/**
 * POST /api/missions/[id]/evaluate
 *
 * On-demand evaluation of a mission's goalCriteria.
 * Returns GoalCriteriaState with per-criterion verdicts.
 * Rate limited to 6 calls per mission per hour.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);

    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, id),
      columns: {
        id: true,
        teamId: true,
        workspaceId: true,
        goalCriteria: true,
        workingBranch: true,
        status: true,
      },
    });

    if (!mission || !(await hasMissionAccess(mission, teamIds))) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }

    const criteria = (mission.goalCriteria as any[]) ?? [];
    if (criteria.length === 0) {
      return NextResponse.json({
        message: 'No goalCriteria set — nothing to evaluate',
        goalCriteriaState: null,
      });
    }

    // Rate limit: max RATE_LIMIT_PER_HOUR on-demand evaluations per mission per hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const [{ value: recentCount }] = await db
      .select({ value: count() })
      .from(missionNotes)
      .where(
        and(
          eq(missionNotes.missionId, id),
          eq(missionNotes.title, 'Goal criteria evaluated (on-demand)'),
          gte(missionNotes.createdAt, oneHourAgo),
        )
      );

    if (Number(recentCount) >= RATE_LIMIT_PER_HOUR) {
      return NextResponse.json(
        { error: `Rate limit: max ${RATE_LIMIT_PER_HOUR} on-demand evaluations per mission per hour` },
        { status: 429 }
      );
    }

    // Gather context: tasks and workers (via task join) and artifacts
    const missionTasks = await db.query.tasks.findMany({
      where: eq(tasks.missionId, id),
      columns: { id: true, status: true, kind: true, title: true, mode: true, creationSource: true, category: true },
    });

    let missionWorkers: Array<{ taskId: string | null; mergedAt: Date | null; prUrl: string | null; branch: string }> = [];
    if (missionTasks.length > 0) {
      const taskIds = missionTasks.map(t => t.id);
      missionWorkers = await db.query.workers.findMany({
        where: inArray(workers.taskId, taskIds),
        columns: { taskId: true, mergedAt: true, prUrl: true, branch: true },
      });
    }

    const missionArtifacts = await db.query.artifacts.findMany({
      where: eq(artifacts.missionId, id),
      columns: { key: true, type: true },
    });

    const evaluatedBy: 'auto' | 'manual' | 'mcp' = apiAccount ? 'mcp' : 'manual';

    const state = evaluateGoalCriteria(
      { id: mission.id, workingBranch: mission.workingBranch },
      criteria as any,
      {
        tasks: missionTasks,
        workers: missionWorkers.map(w => ({
          taskId: w.taskId,
          mergedAt: w.mergedAt,
          prUrl: w.prUrl,
          branchName: w.branch,
          // branchDeleted: not checked without GitHub API call — left undefined
        })),
        artifacts: missionArtifacts.map(a => ({ key: a.key, type: a.type })),
        evaluatedBy,
      }
    );

    // Persist state and optionally transition mission to completed
    const updates: Partial<typeof missions.$inferInsert> = {
      goalCriteriaState: state as any,
      updatedAt: new Date(),
    };

    if (state.overall === 'pass' && mission.status === 'active') {
      updates.status = 'completed';
    }

    await db.update(missions).set(updates).where(eq(missions.id, id));

    // Post a note summarising the result (also used for rate limiting)
    const failedCriteria = state.criteria.filter(c => c.verdict !== 'pass');
    const noteBody = failedCriteria.length > 0
      ? failedCriteria.map(c => `• [${c.verdict}] ${c.label ?? c.type}${c.evidence ? ': ' + c.evidence : ''}`).join('\n')
      : 'All criteria passed.';

    await db.insert(missionNotes).values({
      missionId: id,
      authorType: 'system',
      type: state.overall === 'pass' ? 'update' : 'warning',
      title: 'Goal criteria evaluated (on-demand)',
      body: `Overall: ${state.overall}\n\n${noteBody}`,
      status: 'open',
    }).catch(e => console.error('[evaluate] Failed to post note:', e));

    return NextResponse.json({ goalCriteriaState: state });
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

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);

    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, id),
      columns: { id: true, teamId: true, workspaceId: true, goalCriteria: true, goalCriteriaState: true },
    });

    if (!mission || !(await hasMissionAccess(mission, teamIds))) {
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
