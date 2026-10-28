/**
 * Who sees which Health › Queue (spec "Health › Queue", R-1, R-2): every
 * member of the active team, over the team's workspaces; `workspace` narrows
 * to one of them and `mission` to one mission. Shared by the page and
 * GET /api/health/queue so both read exactly the same scope.
 */
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { isHealthQueueFilter, type HealthQueueFilter, type HealthQueueResponse } from '@buildd/shared';
import { resolveActiveTeamId } from '@/lib/team-access';
import { loadHealthQueue } from '@/lib/health-queue';

export interface HealthQueueParams {
  workspace?: string | null;
  mission?: string | null;
  reason?: string | null;
  page?: string | null;
}

export type HealthQueueLoad =
  | { kind: 'no-team' }
  | { kind: 'no-workspaces' }
  | { kind: 'ok'; view: HealthQueueResponse; workspace: string | null; mission: string | null; workspaces: Array<{ id: string; name: string }> };

export function parseHealthQueueParams(p: HealthQueueParams): { filter: HealthQueueFilter; page: number } {
  const filter = isHealthQueueFilter(p.reason) ? p.reason : 'all';
  const page = Math.max(1, Number.parseInt(p.page ?? '1', 10) || 1);
  return { filter, page };
}

export async function loadHealthQueueFor(userId: string, teamCookie: string | null | undefined, params: HealthQueueParams, now?: Date): Promise<HealthQueueLoad> {
  const teamId = await resolveActiveTeamId(userId, teamCookie);
  if (!teamId) return { kind: 'no-team' };
  const teamWorkspaces = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(eq(workspaces.teamId, teamId));
  if (teamWorkspaces.length === 0) return { kind: 'no-workspaces' };
  const teamWorkspaceIds = teamWorkspaces.map(w => w.id);
  // A workspace outside the active team is ignored, as Health's other tabs do.
  const workspace = params.workspace && teamWorkspaceIds.includes(params.workspace) ? params.workspace : null;
  const mission = params.mission?.trim() || null;
  const { filter, page } = parseHealthQueueParams(params);
  const view = await loadHealthQueue({
    teamId,
    teamWorkspaceIds,
    workspaceIds: workspace ? [workspace] : teamWorkspaceIds,
    missionId: mission,
    filter,
    page,
    now,
  });
  return { kind: 'ok', view, workspace, mission, workspaces: teamWorkspaces };
}
