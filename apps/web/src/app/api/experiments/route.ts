/**
 * /api/experiments — the team's experiment registry.
 *
 * GET   list the experiments the caller can see. `visibility: 'admins'` rows
 *       are filtered out below admin, not flagged — they do not exist for a
 *       member (see apps/web/src/lib/experiments.ts).
 * POST  create a draft. admin|owner only. Nothing enrolls until the
 *       experiment is started with PATCH /api/experiments/[id] {status:'running'}.
 *
 * `?workspaceId=` (optional) resolves the team through that workspace; without
 * it the session's active team, or the API key's own team, is used.
 *
 * A per-task token may list (its own task's workspace's team, team-visible
 * rows, no enrolment health: those are team-wide counts) and nothing else.
 */
import { NextRequest, NextResponse } from 'next/server';
import { bearerOf, resolveExperimentViewer, taskTokenExperimentViewer, type ViewerResult } from '@/lib/experiment-access';
import { isTaskToken } from '@/lib/task-token';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { canViewExperiment, isExperimentAdmin, parseCreateExperiment, toExperimentDTO } from '@/lib/experiments';
import { insertExperiment, listTeamExperiments } from '@/lib/experiments-store';
import { runExperimentHealth } from '@buildd/core/experiment-health-source';
import type { ExperimentHealthFinding } from '@buildd/core/experiment-health';

export async function GET(req: NextRequest) {
  const workspaceParam = req.nextUrl.searchParams.get('workspaceId');
  const bearer = bearerOf(req);
  let who: ViewerResult;
  const taskToken = isTaskToken(bearer);
  if (taskToken) {
    const account = await authenticateTaskScopedCaller(bearer, req);
    if (!account?.taskScope) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (workspaceParam && !taskScopeAllowsWorkspace(account, workspaceParam)) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    who = await taskTokenExperimentViewer(account.taskScope.workspaceId, account.id);
  } else {
    who = await resolveExperimentViewer(req, workspaceParam);
  }
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const { viewer } = who;

  const rows = (await listTeamExperiments(viewer.teamId)).filter(r => canViewExperiment(r.visibility, viewer.role));
  const experiments = rows.map(toExperimentDTO);
  // Enrolment health of the running ones (at most one per kind per team), so a
  // starved or unbalanced experiment shows up where it is listed. A failed
  // check drops that entry rather than the list.
  const health: Record<string, ExperimentHealthFinding[]> = {};
  if (!taskToken) await Promise.all(rows.filter(r => r.status === 'running').map(async r => {
    const findings = await runExperimentHealth(r).catch(() => null);
    if (findings) health[r.id] = findings;
  }));
  return NextResponse.json({ experiments, canManage: isExperimentAdmin(viewer.role), health });
}

export async function POST(req: NextRequest) {
  if (isTaskToken(bearerOf(req))) {
    return NextResponse.json({ error: 'A task token cannot create experiments' }, { status: 403 });
  }
  const who = await resolveExperimentViewer(req, req.nextUrl.searchParams.get('workspaceId'));
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const { viewer } = who;
  if (!isExperimentAdmin(viewer.role)) {
    return NextResponse.json({ error: 'Creating an experiment requires team admin or owner' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = parseCreateExperiment(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });

  const row = await insertExperiment(viewer.teamId, viewer.userId, parsed.value);
  if (row === 'duplicate_key') {
    // Same answer whether the clashing row is team- or admins-visible: only
    // admins reach this line, and admins can see both.
    return NextResponse.json({ error: `An experiment with key "${parsed.value.key}" already exists on this team` }, { status: 409 });
  }
  return NextResponse.json({ experiment: toExperimentDTO(row) }, { status: 201 });
}
