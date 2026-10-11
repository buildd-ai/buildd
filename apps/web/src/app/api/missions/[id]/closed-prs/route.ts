import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, tasks, workers } from '@buildd/core/db/schema';
import { desc, eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { requestingPerson } from '@/lib/request-person';
import { dismissSupersessionSuggestion, recordPrAbandonment, recordPrSupersession } from '@/lib/pr-supersession';

const ACTIONS = new Set(['confirm', 'dismiss', 'abandon']);

/**
 * POST /api/missions/[id]/closed-prs
 *
 * The mission card's answer to a deliverable whose PR closed without merging
 * (`pr_closed_unmerged`). Body: `{ taskId, action, reason? }`.
 *
 *   confirm — record the stored suggestion (lib/pr-supersession-detect.ts) as
 *             a supersession, reason "confirmed by user". Goes through the same
 *             write as record_pr_supersession, so the target must still be
 *             merged and in this workspace or mission.
 *   dismiss — "Not this": drop the suggestion and never offer that PR again.
 *   abandon — the work is deliberately not shipping; `reason` is required.
 *             A person's call (T21, docs/specs/workflow-state-kernel.md): only
 *             a dashboard session or the person's own OAuth session may make
 *             it. An API key or a per-task token is never a person, whatever
 *             its level, and is refused.
 *
 * Writes, so team members only — an open-workspace viewer cannot settle a
 * mission's PRs.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid mission id: expected a UUID, got "${id}".` }, { status: 404 });
  }

  const user = await getCurrentUser();
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);
  if (!user && !apiAccount) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (apiAccount && !hasTokenRouteAdminAccess(apiAccount, req)) {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }
  const person = requestingPerson(user, apiAccount);

  const body = await req.json().catch(() => null) as { taskId?: unknown; action?: unknown; reason?: unknown } | null;
  const taskId = typeof body?.taskId === 'string' ? body.taskId : null;
  const action = typeof body?.action === 'string' ? body.action : null;
  if (!taskId || !isUuid(taskId) || !action || !ACTIONS.has(action)) {
    return NextResponse.json({ error: 'taskId (UUID) and action (confirm | dismiss | abandon) are required' }, { status: 400 });
  }
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (action === 'abandon' && !reason) {
    return NextResponse.json({ error: 'A reason is required to mark a PR abandoned' }, { status: 400 });
  }
  if (action === 'abandon' && !person) {
    return NextResponse.json({
      error: 'Only a person can mark a PR abandoned: ask the owner, or use Abandon on the mission page.',
    }, { status: 403 });
  }

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);
    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, id),
      columns: { id: true, teamId: true },
    });
    if (!mission || !teamIds.includes(mission.teamId)) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { id: true, missionId: true },
      with: {
        workers: {
          columns: { id: true, prUrl: true, prNumber: true, supersessionScan: true },
          orderBy: [desc(workers.startedAt)],
          limit: 1,
        },
      },
    });
    const worker = task?.missionId === id ? task.workers?.[0] : undefined;
    if (!worker?.prUrl) return NextResponse.json({ error: 'Task with a PR not found in this mission' }, { status: 404 });

    const recordedBy = user?.email ?? apiAccount?.name ?? 'unknown';
    const suggestion = worker.supersessionScan?.suggestion ?? null;

    if (action === 'confirm' || action === 'dismiss') {
      if (!suggestion) {
        return NextResponse.json({ error: 'No supersession suggestion is stored for this PR' }, { status: 409 });
      }
      const result = action === 'confirm'
        ? await recordPrSupersession({
            workerId: worker.id,
            supersedingPrNumber: suggestion.prNumber,
            supersedingRepo: suggestion.repo,
            reason: 'confirmed by user',
            recordedBy,
          })
        : await dismissSupersessionSuggestion({ workerId: worker.id, candidatePrUrl: suggestion.prUrl });
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
      return NextResponse.json({ ok: true, action });
    }

    const result = await recordPrAbandonment({ workerId: worker.id, reason, recordedBy, actor: `human:${person}` });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, action });
  } catch (error) {
    console.error('Closed PR resolution error:', error);
    return NextResponse.json({ error: 'Failed to record the decision' }, { status: 500 });
  }
}
