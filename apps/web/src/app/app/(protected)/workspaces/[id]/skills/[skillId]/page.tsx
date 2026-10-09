import { db } from '@buildd/core/db';
import { workspaceSkills } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';

export const dynamic = 'force-dynamic';

/**
 * The old workspace role editor's address. Roles are edited in one place now,
 * Settings › Roles, which opens workspace-scoped roles too. The redirect needs
 * the row's slug, so it is a page, not a next.config redirect.
 */
export default async function WorkspaceSkillRedirect({
  params,
}: {
  params: Promise<{ id: string; skillId: string }>;
}) {
  const { id, skillId } = await params;

  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) notFound();

  const skill = await db.query.workspaceSkills.findFirst({
    where: and(eq(workspaceSkills.id, skillId), eq(workspaceSkills.workspaceId, id)),
    columns: { slug: true },
  });
  if (skill) redirect(`/app/settings/roles/${encodeURIComponent(skill.slug)}`);
  redirect('/app/settings/roles');
}
