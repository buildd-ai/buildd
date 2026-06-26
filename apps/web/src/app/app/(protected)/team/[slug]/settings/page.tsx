import { db } from '@buildd/core/db';
import { workspaceSkills, workspaces } from '@buildd/core/db/schema';
import { eq, and, or, isNull, inArray } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getUserTeamIds } from '@/lib/team-access';
import { TeamRoleEditor } from './TeamRoleEditor';

export const dynamic = 'force-dynamic';

export default async function TeamRoleSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const [wsIds, teamIds] = await Promise.all([
    getUserWorkspaceIds(user.id),
    getUserTeamIds(user.id),
  ]);

  if (teamIds.length === 0) notFound();

  // Find the team-level role by slug
  const teamRole = await db.query.workspaceSkills.findFirst({
    where: and(
      eq(workspaceSkills.slug, slug),
      isNull(workspaceSkills.workspaceId),
      inArray(workspaceSkills.teamId, teamIds),
    ),
  });

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

  // Build delegation options from all accessible roles
  const allRoles = await db.query.workspaceSkills.findMany({
    where: and(
      eq(workspaceSkills.isRole, true),
      eq(workspaceSkills.enabled, true),
      or(
        wsIds.length > 0 ? inArray(workspaceSkills.workspaceId, wsIds) : undefined,
        and(isNull(workspaceSkills.workspaceId), inArray(workspaceSkills.teamId, teamIds)),
      ),
    ),
    columns: { slug: true, name: true },
  });
  const seenDelegateSlugs = new Set<string>();
  const delegateOptions = allRoles
    .filter(r => r.slug !== slug && !seenDelegateSlugs.has(r.slug))
    .map(r => { seenDelegateSlugs.add(r.slug); return { slug: r.slug, name: r.name }; });

  return (
    <TeamRoleEditor
      role={JSON.parse(JSON.stringify(teamRole))}
      overrides={JSON.parse(JSON.stringify(overrides))}
      workspaces={workspaceList}
      delegateOptions={delegateOptions}
    />
  );
}
