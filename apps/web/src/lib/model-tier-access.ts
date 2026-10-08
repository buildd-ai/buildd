/**
 * Who may read or write a team's model-tier settings: shared by the
 * /api/model-tiers routes (registry rows, upgrade policy, certification view).
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import {
  getUserTeamIds,
  getUserTeamRole,
  resolveActiveTeamId,
  verifyWorkspaceAccess,
  verifyAccountWorkspaceAccess,
} from '@/lib/team-access';
import { roleHas, getTeamPermissionOverrides } from '@/lib/permissions';

// Resolve the teamId for a given workspaceId.
async function getTeamIdForWorkspace(workspaceId: string): Promise<string | null> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { teamId: true },
  });
  return ws?.teamId ?? null;
}

export type TeamResolution = { teamId: string } | { error: NextResponse };

/**
 * Resolve which team's registry a request reads or writes, and check the caller
 * may do so.
 *
 * - `workspaceId`: the caller must reach that workspace. Without this check any
 *   session user (or any admin key on another team) could read or overwrite
 *   another team's tier registry, which the claim path then honours. Denied or
 *   missing workspaces 404, like the other workspace routes.
 * - `teamId` (session only): the caller must belong to that team. Settings →
 *   Model tiers sends it, so a user in several teams edits the team on screen.
 * - neither: an API key's own team, or the session's ACTIVE team (the
 *   `buildd-team` cookie), not whichever membership row happens to come first.
 *
 * Session writes also need owner or admin in the resolved team: which model
 * backs a tier sets spend for the whole team, so it is an admin call
 * (knowledge-base: buildd/design/agent-chat.md → Models). API keys are already held to admin level
 * by each handler.
 */
export async function resolveTeam(
  req: NextRequest,
  user: { id: string } | null,
  apiAccount: { id: string; teamId?: string | null } | null,
  opts: { workspaceId: string | null; teamId: string | null; write: boolean },
): Promise<TeamResolution> {
  const fail = (status: number, error: string) => ({ error: NextResponse.json({ error }, { status }) });

  if (apiAccount) {
    if (opts.workspaceId) {
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, opts.workspaceId);
      if (!hasAccess) return fail(404, 'Workspace not found');
      const teamId = await getTeamIdForWorkspace(opts.workspaceId);
      return teamId ? { teamId } : fail(404, 'Workspace not found');
    }
    return apiAccount.teamId ? { teamId: apiAccount.teamId } : fail(400, 'Could not resolve team');
  }

  if (!user) return fail(401, 'Unauthorized');

  let teamId: string | null;
  let role: string | null = null;
  if (opts.workspaceId) {
    const access = await verifyWorkspaceAccess(user.id, opts.workspaceId);
    if (!access?.teamId) return fail(404, 'Workspace not found');
    teamId = access.teamId;
    role = (access as { role?: string | null }).role ?? null;
  } else if (opts.teamId) {
    const teamIds = await getUserTeamIds(user.id);
    if (!teamIds.includes(opts.teamId)) return fail(404, 'Team not found');
    teamId = opts.teamId;
  } else {
    teamId = await resolveActiveTeamId(user.id, req.cookies.get('buildd-team')?.value);
  }
  if (!teamId) return fail(400, 'Could not resolve team');

  if (opts.write) {
    if (!role) role = await getUserTeamRole(user.id, teamId);
    if (!roleHas(role, 'manage_model_tiers', await getTeamPermissionOverrides(teamId))) {
      return fail(403, 'Only a team owner or admin can change model tiers');
    }
  }
  return { teamId };
}

/** Session user or API key, with API keys held to admin level. */
export async function authenticate(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);

  if (!user && !apiAccount) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  if (apiAccount && !hasTokenRouteAdminAccess(apiAccount, req)) {
    return { error: NextResponse.json({ error: 'Admin token required' }, { status: 403 }) };
  }
  return { user, apiAccount: apiAccount as { id: string; teamId?: string | null } | null };
}

