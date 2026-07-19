import { redirect, notFound } from 'next/navigation';
import { db } from '@buildd/core/db';
import { workspaces, workspaceSkills, missions } from '@buildd/core/db/schema';
import { eq, and, isNotNull } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { resolvePolicy } from '@/lib/merge-policy';
import MergePolicyEditor from './MergePolicyEditor';

export const dynamic = 'force-dynamic';

export default async function WorkspaceMergePolicyPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const access = await verifyWorkspaceAccess(user.id, workspaceId);
  if (!access) notFound();

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { id: true, name: true, gitConfig: true },
  });
  if (!workspace) notFound();

  // Load roles for the workspace (skills with isRole = true)
  const roles = await db.query.workspaceSkills.findMany({
    where: and(
      eq(workspaceSkills.workspaceId, workspaceId),
      eq(workspaceSkills.isRole, true),
    ),
    columns: { slug: true, name: true },
  });

  // Load missions with per-mission merge policy overrides
  const missionsWithOverrides = await db.query.missions.findMany({
    where: and(
      eq(missions.workspaceId, workspaceId),
      isNotNull(missions.mergePolicy),
    ),
    columns: { id: true, title: true, mergePolicy: true },
  });

  const effectivePolicy = resolvePolicy(workspace);

  const missionOverrides = missionsWithOverrides
    .filter(m => m.mergePolicy != null)
    .map(m => ({ id: m.id, title: m.title, policy: m.mergePolicy! }));

  return (
    <main className="min-h-screen pt-14 px-4 pb-24 md:p-8 md:pb-8">
      <div className="max-w-2xl mx-auto">
        <MergePolicyEditor
          workspaceId={workspaceId}
          workspaceName={workspace.name}
          initial={effectivePolicy}
          roles={roles.map(r => ({ slug: r.slug, name: r.name }))}
          missionOverrides={missionOverrides}
        />
      </div>
    </main>
  );
}
