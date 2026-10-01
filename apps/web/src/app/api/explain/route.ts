import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { db } from '@buildd/core/db';
import { missions, tasks, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getTeamWorkspaceIds, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import type { EvidenceActor } from '@/lib/evidence-audit';
import { resolveWorkerByPrNumber, resolveWorkerByPrNumberInWorkspaces } from '@/lib/pr-resolve';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveSessionTeamIds, workspaceIdsForTeams } from '@/lib/session-team-scope';
import { explainMission, explainTask, explainWorkspace, explainPr } from '@/lib/explain';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/explain
 *
 * "What state is this in, what is it waiting on, and what is the evidence?" —
 * for exactly one subject, in one shape, across four scopes.
 *
 * Query params — supply EXACTLY ONE of:
 *   taskId      — a task UUID
 *   missionId   — a mission UUID
 *   workspaceId — a workspace UUID; returns the gated subjects, ranked
 *   prNumber    — a PR number; pass workspaceId too when the same number exists
 *                 in more than one of the team's repos
 *
 * `workspaceId` doubles as the PR disambiguator, so it is the one param that
 * may accompany `prNumber`. Every other pair is rejected rather than
 * silently preferring one: "explain this" with two subjects is a caller bug,
 * and guessing which one they meant is how a confident wrong answer gets made.
 *
 * Auth: an API key (scope = the key's team), or the dashboard session (scope =
 * the user's teams; an optional `teamId` param pins it to one of them, and a
 * pin outside them 404s). A key, when present, is authoritative and `teamId`
 * is ignored on that path. Subjects outside the scope 404 on both paths.
 *
 * A key is also held to the workspace reach rule for the task, PR and
 * workspace subjects, which carry the task's inline evidence list: a
 * restricted workspace is reachable only by linked accounts
 * (`verifyAccountWorkspaceAccess`), exactly as GET /api/tasks/[id] decides it.
 * A session is decided by team membership, as there.
 *
 * Read-only. No model is invoked, no verification task is dispatched, no
 * merge is attempted — see the module note on `@/lib/explain`.
 */
export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const account = await authenticateApiKey(authHeader?.replace('Bearer ', '') ?? null, req);
    const sessionUser = account ? null : await getCurrentUser();
    if (!account && !sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (account && !account.teamId) {
      return NextResponse.json({ error: 'No team associated with this account' }, { status: 400 });
    }

    const { searchParams } = new URL(req.url);
    const taskId = searchParams.get('taskId');
    const missionId = searchParams.get('missionId');
    const workspaceId = searchParams.get('workspaceId');
    const prNumberRaw = searchParams.get('prNumber');

    // workspaceId is the PR disambiguator, so it does not count as a second
    // subject when prNumber is present.
    const subjects = [
      taskId ? 'taskId' : null,
      missionId ? 'missionId' : null,
      prNumberRaw ? 'prNumber' : null,
      workspaceId && !prNumberRaw ? 'workspaceId' : null,
    ].filter(Boolean) as string[];

    if (subjects.length === 0) {
      return NextResponse.json(
        { error: 'Pass exactly one of taskId, missionId, workspaceId or prNumber.' },
        { status: 400 },
      );
    }
    if (subjects.length > 1) {
      return NextResponse.json(
        { error: `Pass exactly one subject — received ${subjects.join(', ')}.` },
        { status: 400 },
      );
    }

    let teamIds: string[];
    let teamWsIds: string[];
    if (account) {
      teamIds = [account.teamId];
      teamWsIds = await getTeamWorkspaceIds(account.teamId);
    } else {
      const sessionTeamIds = await resolveSessionTeamIds(sessionUser!.id, searchParams.get('teamId'));
      if (!sessionTeamIds) {
        return NextResponse.json({ error: 'Team not found' }, { status: 404 });
      }
      teamIds = sessionTeamIds;
      teamWsIds = await workspaceIdsForTeams(teamIds);
    }
    if (teamWsIds.length === 0) {
      return NextResponse.json({ error: 'No workspaces found for account' }, { status: 403 });
    }

    // Team scope is necessary but not sufficient for a key: a restricted
    // workspace admits only linked accounts. Sessions were scoped by team
    // membership above, the rule GET /api/tasks/[id] applies to them.
    const reaches = async (wsId: string) => !account || verifyAccountWorkspaceAccess(account.id, wsId);
    const actor: EvidenceActor = account ? { accountId: account.id } : { userId: sessionUser!.id };

    // ── PR ──────────────────────────────────────────────────────────────────
    if (prNumberRaw) {
      const prNumber = parseInt(prNumberRaw, 10);
      if (Number.isNaN(prNumber)) {
        return NextResponse.json({ error: `Invalid prNumber: "${prNumberRaw}"` }, { status: 400 });
      }
      // The same resolver `get_pr` uses. A second one would eventually disagree
      // about which workspaces a team can see.
      const resolved = account
        ? await resolveWorkerByPrNumber(account, prNumber, workspaceId)
        : await resolveWorkerByPrNumberInWorkspaces(teamWsIds, prNumber, workspaceId);
      if (typeof resolved.status === 'number') {
        return NextResponse.json(
          { error: resolved.error, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) },
          { status: resolved.status },
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const worker = resolved as any;
      if (!(await reaches(worker.workspaceId))) {
        return NextResponse.json({ error: 'PR not found' }, { status: 404 });
      }
      const result = await explainPr({
        id: worker.id,
        taskId: worker.taskId ?? null,
        workspaceId: worker.workspaceId,
        prNumber: worker.prNumber ?? prNumber,
        prUrl: worker.prUrl ?? null,
        branch: worker.branch ?? null,
        prBaseRef: worker.prBaseRef ?? null,
        prLifecycleStatus: worker.prLifecycleStatus ?? null,
        conflictDetectedAt: worker.conflictDetectedAt ?? null,
        prOpenedBaseSha: worker.prOpenedBaseSha ?? null,
        mergedAt: worker.mergedAt ?? null,
        observedTouches: (worker.observedTouches as string[] | null) ?? null,
        createdAt: worker.createdAt ?? null,
      }, actor);
      if (!result) {
        return NextResponse.json(
          { error: `PR #${prNumber} has no task attached — nothing to explain.` },
          { status: 404 },
        );
      }
      return NextResponse.json(result);
    }

    // ── Task ────────────────────────────────────────────────────────────────
    if (taskId) {
      if (!UUID_RE.test(taskId)) {
        return NextResponse.json({ error: `Invalid taskId: expected a UUID, got "${taskId}".` }, { status: 400 });
      }
      const row = await db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
        columns: { id: true, workspaceId: true },
      });
      if (!row || !row.workspaceId || !teamWsIds.includes(row.workspaceId) || !(await reaches(row.workspaceId))) {
        return NextResponse.json({ error: 'Task not found or not in your team' }, { status: 404 });
      }
      const result = await explainTask(taskId, actor);
      if (!result) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      return NextResponse.json(result);
    }

    // ── Mission ─────────────────────────────────────────────────────────────
    if (missionId) {
      if (!UUID_RE.test(missionId)) {
        return NextResponse.json({ error: `Invalid missionId: expected a UUID, got "${missionId}".` }, { status: 400 });
      }
      const row = await db.query.missions.findFirst({
        where: eq(missions.id, missionId),
        columns: { id: true, teamId: true, workspaceId: true },
      });
      if (!row) {
        return NextResponse.json({ error: 'Mission not found or not in your team' }, { status: 404 });
      }
      // Authorize by teamId (team-level missions) or workspaceId (workspace-scoped missions)
      const hasAccess = teamIds.includes(row.teamId) || (row.workspaceId && teamWsIds.includes(row.workspaceId));
      if (!hasAccess) {
        return NextResponse.json({ error: 'Mission not found or not in your team' }, { status: 404 });
      }
      const result = await explainMission(missionId);
      if (!result) return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
      return NextResponse.json(result);
    }

    // ── Workspace ───────────────────────────────────────────────────────────
    if (!UUID_RE.test(workspaceId!)) {
      return NextResponse.json(
        { error: `Invalid workspaceId: expected a UUID, got "${workspaceId}". Resolve names to UUIDs before calling this endpoint.` },
        { status: 400 },
      );
    }
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId!),
      columns: { id: true, teamId: true },
    });
    if (!ws || !teamIds.includes(ws.teamId) || !(await reaches(ws.id))) {
      return NextResponse.json({ error: 'Workspace not found or not in your team' }, { status: 404 });
    }
    return NextResponse.json(await explainWorkspace(workspaceId!, actor));
  } catch (error) {
    console.error('[explain] failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to explain' },
      { status: 500 },
    );
  }
}
