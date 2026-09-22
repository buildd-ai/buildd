/**
 * Who is asking, on which team, with what role — for /api/experiments.
 *
 * Experiments are team-scoped, and the role decides both what a caller may
 * write (admin|owner) and what exists for them (see canViewExperiment).
 *
 * - Session: the team is the workspace's team when `workspaceId` is given
 *   (access verified), else the active team (the `buildd-team` cookie, with
 *   resolveActiveTeamId's fallbacks). Role = the caller's team_members row.
 * - `bld_` API key (the MCP path): the team is the workspace's when
 *   `workspaceId` is given and the account can reach it, else the account's
 *   own team. Role follows the token level: an admin token acts as `admin`,
 *   anything below as `member` — the same line the MCP action gating draws.
 * - OAuth bearer: authenticateApiKey forces these to admin level for every
 *   human, whatever their team role. Here the human's real team_members role
 *   is used instead, so an OAuth-connected member cannot see or change an
 *   admins-only experiment that the dashboard would hide from them.
 */
import type { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { teamMembers, workspaces } from '@buildd/core/db/schema';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { looksLikeJwt, verifyAccessTokenAnyAudience } from '@/lib/oauth/tokens';
import { resolveActiveTeamId, verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from '@/lib/team-access';
import type { TeamRole } from './experiments';

export interface ExperimentViewer {
  teamId: string;
  role: TeamRole;
  userId: string | null;
}

export type ViewerResult =
  | { ok: true; viewer: ExperimentViewer }
  | { ok: false; status: 401 | 404; error: string };

const notFound = (what: string): ViewerResult => ({ ok: false, status: 404, error: `${what} not found` });

async function memberRole(teamId: string, userId: string): Promise<TeamRole | null> {
  const m = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)),
    columns: { role: true },
  });
  return (m?.role as TeamRole | undefined) ?? null;
}

export async function resolveExperimentViewer(req: NextRequest, workspaceId: string | null): Promise<ViewerResult> {
  const authHeader = req.headers.get('authorization');
  const bearer = authHeader?.replace(/^Bearer\s+/i, '') || null;
  const account = bearer ? await authenticateApiKey(bearer) : null;

  if (bearer && account) {
    let teamId: string | null = (account as { teamId?: string | null }).teamId ?? null;
    if (workspaceId) {
      if (!(await verifyAccountWorkspaceAccess(account.id, workspaceId))) return notFound('Workspace');
      const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { teamId: true } });
      teamId = ws?.teamId ?? null;
    }
    if (!teamId) return notFound('Team');

    if (looksLikeJwt(bearer)) {
      const claims = await verifyAccessTokenAnyAudience(bearer);
      const role = claims?.sub ? await memberRole(teamId, claims.sub) : null;
      if (!role) return notFound('Team');
      return { ok: true, viewer: { teamId, role, userId: claims!.sub } };
    }
    return { ok: true, viewer: { teamId, role: account.level === 'admin' ? 'admin' : 'member', userId: null } };
  }

  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' };

  if (workspaceId) {
    const access = await verifyWorkspaceAccess(user.id, workspaceId);
    if (!access) return notFound('Workspace');
    // verifyWorkspaceAccess answers 'member' for an open workspace without
    // looking at membership, which would demote a team admin; read the row.
    const role = (await memberRole(access.teamId, user.id)) ?? 'member';
    return { ok: true, viewer: { teamId: access.teamId, role, userId: user.id } };
  }

  const teamId = await resolveActiveTeamId(user.id, req.cookies.get('buildd-team')?.value ?? null);
  if (!teamId) return notFound('Team');
  const role = await memberRole(teamId, user.id);
  if (!role) return notFound('Team');
  return { ok: true, viewer: { teamId, role, userId: user.id } };
}
