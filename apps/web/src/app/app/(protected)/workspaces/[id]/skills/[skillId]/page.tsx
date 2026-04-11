import { db } from '@buildd/core/db';
import { workspaces, workspaceSkills } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess, getUserWorkspaceIds } from '@/lib/team-access';
import { RoleEditor } from './RoleEditor';

export const dynamic = 'force-dynamic';

export default async function SkillDetailPage({
  params,
}: {
  params: Promise<{ id: string; skillId: string }>;
}) {
  const { id, skillId } = await params;

  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) notFound();

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    columns: { id: true, name: true },
  });
  if (!workspace) notFound();

  const skill = await db.query.workspaceSkills.findFirst({
    where: and(
      eq(workspaceSkills.id, skillId),
      eq(workspaceSkills.workspaceId, id),
    ),
  });
  if (!skill) notFound();

  // Get all other skills in workspace for delegation picker
  const otherSkills = await db.query.workspaceSkills.findMany({
    where: and(
      eq(workspaceSkills.workspaceId, id),
      eq(workspaceSkills.enabled, true),
    ),
    columns: { slug: true, name: true },
  });

  const delegateOptions = otherSkills
    .filter(s => s.slug !== skill.slug)
    .map(s => ({ slug: s.slug, name: s.name }));

  // Fetch all user workspaces for the workspace picker
  const allWorkspaceIds = await getUserWorkspaceIds(user.id);
  const allWorkspaces = allWorkspaceIds.length > 0
    ? await db.query.workspaces.findMany({
        where: inArray(workspaces.id, allWorkspaceIds),
        columns: { id: true, name: true },
      })
    : [];

  return (
    <RoleEditor
      workspaceId={id}
      workspaceName={workspace.name}
      skill={JSON.parse(JSON.stringify(skill))}
      delegateOptions={delegateOptions}
      workspaces={allWorkspaces}
    />
  );
}
