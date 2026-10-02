import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { isSurfaceAuditTask } from '@buildd/core/surface-audit';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { evaluateSurfaceAuditGate, loadSurfaceAuditGateTasks } from '@/lib/mission-surface-audit-gate';
import { adviseSurfaceAudit, cachedSurfaceAuditAdvice } from '@/lib/surface-audit-advice';
import { isUuid } from '@/lib/uuid';
import { workspaceOpenToCaller } from '@/lib/open-workspaces';

/**
 * POST /api/missions/[id]/surface-audit/advice
 *
 * A decision model's suggestion for the decision sheet: run the visual audit or
 * waive it. A suggestion only: it writes nothing, and the sheet's person
 * confirms. Always 200 for an open mission; `advice: null` means "no
 * suggestion" (no key, timeout, low confidence, sensitive workspace), and the
 * sheet shows both actions with nothing pre-selected. POST rather than GET so
 * a prefetch cannot spend.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid mission id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }

  const user = await getCurrentUser();
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);
  if (!user && !apiAccount) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (apiAccount && !hasTokenRouteAdminAccess(apiAccount, req)) {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);
    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, id),
      columns: { id: true, teamId: true, workspaceId: true, autoSurfaceAudit: true },
    });
    const allowed = !!mission && (
      teamIds.includes(mission.teamId)
      || (!!mission.workspaceId && await workspaceOpenToCaller(mission.workspaceId, { teamIds, accountId: apiAccount?.id }))
    );
    if (!mission || !allowed) return NextResponse.json({ error: 'Mission not found' }, { status: 404 });

    const tasks = await loadSurfaceAuditGateTasks(id);
    const shipped = tasks.filter(t => t.taskClass === 'work' && t.status === 'completed' && !isSurfaceAuditTask(t.title ?? ''));
    const prNumbers = shipped.flatMap(t => {
      const n = t.workers?.[0]?.prNumber;
      return typeof n === 'number' ? [n] : [];
    });

    const cached = cachedSurfaceAuditAdvice(id, prNumbers);
    if (cached) return NextResponse.json({ advice: cached });

    const gate = await evaluateSurfaceAuditGate(mission, tasks);
    if (!gate.required) return NextResponse.json({ advice: null });

    const workspace = mission.workspaceId
      ? await db.query.workspaces.findFirst({ where: eq(workspaces.id, mission.workspaceId), columns: { gitConfig: true } })
      : null;

    const advice = await adviseSurfaceAudit({
      missionId: id,
      teamId: mission.teamId,
      workspaceId: mission.workspaceId,
      accountId: apiAccount?.id ?? null,
      userId: user?.id ?? null,
      dataClass: workspace?.gitConfig?.dataClass ?? null,
      uiPaths: gate.uiPaths,
      workTitles: shipped.map(t => t.title ?? '').filter(Boolean),
      prNumbers,
    });
    return NextResponse.json({ advice });
  } catch (error) {
    console.error('Surface audit advice error:', error);
    // Advice is optional: a failure is "no suggestion", never an error the sheet has to render.
    return NextResponse.json({ advice: null });
  }
}
