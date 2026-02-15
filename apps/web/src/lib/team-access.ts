import { cache } from 'react';
import { db } from '@buildd/core/db';
import { teamMembers, workspaces, accountWorkspaces, teams } from '@buildd/core/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';

type TeamRole = 'owner' | 'admin' | 'member';

const ROLE_HIERARCHY: Record<TeamRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

/**
 * Verify a user has access to a workspace via team membership.
 * Optionally checks for a minimum role level.
 */
export async function verifyWorkspaceAccess(
  userId: string,
  workspaceId: string,
  requiredRole?: TeamRole
): Promise<{ teamId: string; role: TeamRole } | null> {
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { teamId: true },
  });

  if (!workspace) return null;

  const membership = await db.query.teamMembers.findFirst({
    where: and(
      eq(teamMembers.teamId, workspace.teamId),
      eq(teamMembers.userId, userId)
    ),
  });

  if (!membership) return null;

  const role = membership.role as TeamRole;

  if (requiredRole && ROLE_HIERARCHY[role] < ROLE_HIERARCHY[requiredRole]) {
    return null;
  }

  return { teamId: workspace.teamId, role };
}

/**
 * Verify an API key account has access to a workspace.
 * Checks accountWorkspaces link or workspace accessMode === 'open'.
 */
export async function verifyAccountWorkspaceAccess(
  accountId: string,
  workspaceId: string,
  permission?: 'canClaim' | 'canCreate'
): Promise<boolean> {
  // Check workspace access mode first
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { id: true, accessMode: true },
  });

  if (!workspace) return false;

  if (workspace.accessMode === 'open') return true;

  // Check explicit link
  const link = await db.query.accountWorkspaces.findFirst({
    where: and(
      eq(accountWorkspaces.accountId, accountId),
      eq(accountWorkspaces.workspaceId, workspaceId)
    ),
  });

  if (!link) return false;

  if (permission === 'canClaim' && !link.canClaim) return false;
  if (permission === 'canCreate' && !link.canCreate) return false;

  return true;
}

/**
 * Get all workspace IDs accessible to a user via their team memberships.
 */
export async function getUserWorkspaceIds(userId: string): Promise<string[]> {
  const memberships = await db.query.teamMembers.findMany({
    where: eq(teamMembers.userId, userId),
    columns: { teamId: true },
  });

  if (memberships.length === 0) return [];

  const teamIds = memberships.map(m => m.teamId);

  const userWorkspaces = await db.query.workspaces.findMany({
    where: inArray(workspaces.teamId, teamIds),
    columns: { id: true },
  });

  return userWorkspaces.map(w => w.id);
}

/**
 * Get all team IDs a user belongs to.
 */
export async function getUserTeamIds(userId: string): Promise<string[]> {
  const memberships = await db.query.teamMembers.findMany({
    where: eq(teamMembers.userId, userId),
    columns: { teamId: true },
  });

  return memberships.map(m => m.teamId);
}

/**
 * Get the user's default (personal) team ID.
 * This is the team with slug 'personal-{userId}'.
 */
export async function getUserDefaultTeamId(userId: string): Promise<string | null> {
  const team = await db.query.teams.findFirst({
    where: eq(teams.slug, `personal-${userId}`),
    columns: { id: true },
  });

  return team?.id || null;
}

export type UserTeam = {
  id: string;
  name: string;
  slug: string;
  role: string;
  memberCount: number;
};

/**
 * Get all teams a user belongs to with role and member counts.
 * Cached per-request via React cache() so layout + page share the same result.
 */
export const getUserTeamsWithDetails = cache(async (userId: string): Promise<UserTeam[]> => {
  const memberships = await db.query.teamMembers.findMany({
    where: eq(teamMembers.userId, userId),
    with: { team: true },
  });

  const validMemberships = memberships.filter(m => m.team != null);
  if (validMemberships.length === 0) return [];

  const memberTeamIds = validMemberships.map(m => m.teamId);

  let countMap = new Map<string, number>();
  try {
    const memberCounts = await db
      .select({
        teamId: teamMembers.teamId,
        count: sql<number>`count(*)::int`,
      })
      .from(teamMembers)
      .where(inArray(teamMembers.teamId, memberTeamIds))
      .groupBy(teamMembers.teamId);

    countMap = new Map(memberCounts.map(mc => [mc.teamId, mc.count]));
  } catch {
    // Member counts are non-critical, default to 1
  }

  return validMemberships.map(m => ({
    id: m.team.id,
    name: m.team.name,
    slug: m.team.slug,
    role: m.role,
    memberCount: countMap.get(m.teamId) || 1,
  }));
});
