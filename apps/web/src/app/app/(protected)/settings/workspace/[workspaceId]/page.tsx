import { redirect, notFound } from 'next/navigation';
import { db } from '@buildd/core/db';
import { workspaces, workspaceSkills, missions, tasks } from '@buildd/core/db/schema';
import { eq, and, isNotNull, gte, desc, sql } from 'drizzle-orm';
import { collectPolicySuggestions } from '@/lib/policy-suggestions';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess, getUserTeamsWithDetails } from '@/lib/team-access';
import { resolvePolicy } from '@/lib/merge-policy';
import { MoveToTeamButton } from '@/components/MoveToTeamDialog';
import { moveTargets } from '../../workspaces/rows';
import MergePolicyEditor from './MergePolicyEditor';
import { getTeamsPermissionOverrides, getTeamPermissionOverrides, roleHas } from '@/lib/permissions';
import { loadWorkspaceRepoFacts, memberHasRepoAccess } from '@/lib/member-repo-access';
import MemberRepoAccessSection from './MemberRepoAccessSection';

export const dynamic = 'force-dynamic';

const SUGGESTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
    columns: { id: true, name: true, teamId: true, gitConfig: true },
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

  // Paths recent reviews flagged outside every risk class. Best-effort: the
  // page renders without them.
  const policyConfig = workspace.gitConfig?.policyConfig ?? null;
  const policySuggestions = policyConfig
    ? await db
        .select({ context: tasks.context })
        .from(tasks)
        .where(and(
          eq(tasks.workspaceId, workspaceId),
          eq(tasks.category, 'review'),
          gte(tasks.createdAt, new Date(Date.now() - SUGGESTION_WINDOW_MS)),
          sql`${tasks.context}->'policySuggestions' is not null`,
        ))
        .orderBy(desc(tasks.createdAt))
        .limit(200)
        .then(rows => collectPolicySuggestions(rows.map(r => r.context), policyConfig))
        .catch(() => [])
    : [];

  const teams = await getUserTeamsWithDetails(user.id).catch(() => []);
  const moveTeams = moveTargets(user.id, teams, workspace.teamId, await getTeamsPermissionOverrides(teams.map((t) => t.id)));

  // Opt-in GitHub repo check (lib/member-repo-access.ts): the setting, and the
  // viewer's own result while it is on.
  const repoFacts = await loadWorkspaceRepoFacts(workspaceId).catch(() => null);
  const repoAccessMode = repoFacts?.mode ?? 'off';
  const viewerRepoAccess = repoAccessMode === 'off' ? null : await memberHasRepoAccess(user.id, workspaceId);
  const canManageSettings = roleHas(access.role, 'manage_workspace_settings', await getTeamPermissionOverrides(workspace.teamId));

  const missionOverrides = missionsWithOverrides
    .filter(m => m.mergePolicy != null)
    .map(m => ({ id: m.id, title: m.title, policy: m.mergePolicy! }));

  return (
    <main className="min-h-screen pt-14 px-4 pb-24 md:p-8 md:pb-8">
      <div className="max-w-2xl">
        <MergePolicyEditor
          workspaceId={workspaceId}
          workspaceName={workspace.name}
          initial={effectivePolicy}
          policyConfig={policyConfig}
          policySuggestions={policySuggestions}
          roles={roles.map(r => ({ slug: r.slug, name: r.name }))}
          missionOverrides={missionOverrides}
          canEdit={canManageSettings}
          headerAction={moveTeams && (
            <MoveToTeamButton
              workspace={{ id: workspace.id, name: workspace.name, teamId: workspace.teamId }}
              teams={moveTeams}
            />
          )}
        />
        <MemberRepoAccessSection
          workspaceId={workspaceId}
          mode={repoAccessMode}
          repoFullName={repoFacts?.repoFullName ?? null}
          canManage={canManageSettings}
          viewer={viewerRepoAccess}
        />
      </div>
    </main>
  );
}
