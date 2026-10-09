import { db } from '@buildd/core/db';
import { workspaceSkills, workspaces, users } from '@buildd/core/db/schema';
import { eq, and, or, isNull, inArray } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getUserTeamIds, getUserTeamRole } from '@/lib/team-access';
import { getTeamPermissionOverrides, roleHas, can } from '@/lib/permissions';
import { findVisibleTeamLevelRole, isPersonalRole } from '@/lib/personal-roles';
import { isUuid } from '@/lib/uuid';
import { personalRoleAccess } from '@/lib/personal-roles-shared';
import { buildDelegateOptions } from '@/lib/delegate-options';
import { DEFAULT_ROLES, seedDefaultRolesForTeam } from '@/lib/default-roles';
import { TeamRoleEditor } from './TeamRoleEditor';

export const dynamic = 'force-dynamic';

export default async function TeamRoleSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ id?: string }>;
}) {
  const [{ slug }, { id: roleId }] = await Promise.all([params, searchParams]);
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const [wsIds, teamIds] = await Promise.all([
    getUserWorkspaceIds(user.id),
    getUserTeamIds(user.id),
  ]);

  if (teamIds.length === 0) notFound();

  // Visible to the viewer, from their own teams: their own personal roles,
  // teammates' shared ones, never another member's private one.
  const delegateRows = () => db.query.workspaceSkills.findMany({
    where: and(
      eq(workspaceSkills.isRole, true),
      eq(workspaceSkills.enabled, true),
      or(
        wsIds.length > 0 ? inArray(workspaceSkills.workspaceId, wsIds) : undefined,
        and(
          isNull(workspaceSkills.workspaceId),
          inArray(workspaceSkills.teamId, teamIds),
          or(
            isNull(workspaceSkills.ownerUserId),
            eq(workspaceSkills.ownerUserId, user.id),
            eq(workspaceSkills.visibility, 'team'),
          ),
        ),
      ),
    ),
    columns: { slug: true, name: true, workspaceId: true },
  });

  // A personal role is addressed by id: its slug is unique per owner, not per team.
  if (roleId) {
    const personal = isUuid(roleId) ? await findVisibleTeamLevelRole(roleId, user.id) : undefined;
    if (!personal || personal.slug !== slug) notFound();
    if (!isPersonalRole(personal)) redirect(`/app/team/${encodeURIComponent(personal.slug)}/settings`);

    const isOwner = personal.ownerUserId === user.id;
    const canManageRoles = await can({ kind: 'user', userId: user.id }, 'manage_agent_roles', personal.teamId).catch(() => false);
    const access = personalRoleAccess({ isOwner, visibility: personal.visibility, canManageRoles });
    const owner = isOwner ? null : await db.query.users.findFirst({
      where: eq(users.id, personal.ownerUserId!),
      columns: { name: true, email: true },
    });
    const delegateOptions = buildDelegateOptions(await delegateRows(), slug, new Map());

    return (
      <TeamRoleEditor
        role={JSON.parse(JSON.stringify(personal))}
        overrides={[]}
        workspaces={[]}
        delegateOptions={delegateOptions}
        canEdit={access.canEdit}
        personal={{
          visibility: personal.visibility === 'team' ? 'team' : 'private',
          isOwner,
          ownerName: owner ? (owner.name || owner.email?.split('@')[0] || null) : null,
          canShare: access.canShare,
          canPromote: access.canPromote,
        }}
      />
    );
  }

  // Find the team-level role by slug
  const findTeamRole = () => db.query.workspaceSkills.findFirst({
    where: and(
      eq(workspaceSkills.slug, slug),
      isNull(workspaceSkills.workspaceId),
      // A team role, not a personal row that happens to share the slug.
      isNull(workspaceSkills.ownerUserId),
      inArray(workspaceSkills.teamId, teamIds),
    ),
  });
  let teamRole = await findTeamRole();

  // A default role slug added after a team was created (e.g. Operator,
  // PR #3622) never reaches that team's rows on its own — seeding only runs
  // at team creation. seedDefaultRolesForTeam is onConflictDoNothing per
  // (teamId, slug), so calling it here is safe and brings every one of the
  // user's teams up to date lazily, instead of 404ing a role that exists in
  // code but was never inserted for this team.
  if (!teamRole && teamIds.length > 0 && DEFAULT_ROLES.some(r => r.slug === slug)) {
    try {
      await Promise.all(teamIds.map(teamId => seedDefaultRolesForTeam(teamId)));
      teamRole = await findTeamRole();
    } catch {
      // Read-only database (e.g. visual-QA's DISABLE_WRITES clone): fall
      // through to the existing not-found handling below.
    }
  }

  if (!teamRole) {
    // Fall back: check if there's a workspace-scoped role (legacy)
    if (wsIds.length > 0) {
      const wsRole = await db.query.workspaceSkills.findFirst({
        where: and(
          eq(workspaceSkills.slug, slug),
          inArray(workspaceSkills.workspaceId, wsIds),
        ),
      });
      if (wsRole) {
        redirect(`/app/workspaces/${wsRole.workspaceId}/skills/${wsRole.id}`);
      }
    }
    notFound();
  }

  // The roles routes take manage_agent_roles in the role's team, with that
  // team's overrides (a personal team counts as owned). Without it the editor
  // is read-only. A failed overrides read holds nothing.
  const [viewerRole, permissionOverrides] = await Promise.all([
    getUserTeamRole(user.id, teamRole.teamId).catch(() => null),
    getTeamPermissionOverrides(teamRole.teamId).catch(() => null),
  ]);
  const canEdit = !!permissionOverrides && roleHas(viewerRole, 'manage_agent_roles', permissionOverrides);

  // Get all workspace overrides for this role
  const overrides = wsIds.length > 0
    ? await db.query.workspaceSkills.findMany({
        where: and(
          eq(workspaceSkills.teamId, teamRole.teamId),
          eq(workspaceSkills.slug, slug),
          inArray(workspaceSkills.workspaceId, wsIds),
        ),
      })
    : [];

  // Get workspace name map
  const workspaceList = wsIds.length > 0
    ? await db.query.workspaces.findMany({
        where: inArray(workspaces.id, wsIds),
        columns: { id: true, name: true },
      })
    : [];

  // Build delegation options from all accessible roles (include workspaceId for qualification)
  const allRoles = await delegateRows();
  // One option per slug: canDelegateTo stores slugs, and the same slug can
  // exist in several workspaces.
  const delegateOptions = buildDelegateOptions(
    allRoles,
    slug,
    new Map(workspaceList.map(w => [w.id, w.name])),
  );

  return (
    <TeamRoleEditor
      role={JSON.parse(JSON.stringify(teamRole))}
      overrides={JSON.parse(JSON.stringify(overrides))}
      workspaces={workspaceList}
      delegateOptions={delegateOptions}
      canEdit={canEdit}
    />
  );
}
