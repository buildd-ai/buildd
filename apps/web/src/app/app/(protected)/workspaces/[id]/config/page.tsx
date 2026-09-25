import { db } from '@buildd/core/db';
import { workspaces, type WorkspaceGitConfig, type WorkspaceReleaseConfig, type WorkspaceWorkTrackerConfig } from '@buildd/core/db/schema';
import { resolveReleaseTrigger } from '@buildd/core/release-strategy';
import { resolveBranchStrategy } from '@buildd/core/branch-strategy';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { GitConfigForm } from './GitConfigForm';
import { WorkspaceHealthCard } from './WorkspaceHealthCard';
import { checkWorkspaceHealth } from '@/lib/workspace-health';
import ConnectClaudeSection from './ConnectClaudeSection';
import ReleaseSection from './ReleaseSection';
import BranchStrategySection from './BranchStrategySection';
import WorkTrackerSection from './WorkTrackerSection';
import KnowledgeHealthSection from './KnowledgeHealthSection';
import SubjectPolicySection from './SubjectPolicySection';
import { verifyWorkspaceAccess, getUserTeamsWithDetails } from '@/lib/team-access';

export default async function WorkspaceConfigPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    const user = await getCurrentUser();

    if (!user) {
        redirect('/app/auth/signin');
    }

    const access = await verifyWorkspaceAccess(user.id, id);
    if (!access) notFound();

    const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, id),
        columns: {
            id: true,
            name: true,
            repo: true,
            teamId: true,
            gitConfig: true,
            configStatus: true,
            accessMode: true,
            releaseConfig: true,
            workTrackerConfig: true,
        },
    });

    const userTeams = await getUserTeamsWithDetails(user.id);

    if (!workspace) {
        notFound();
    }

    return (
        <main className="min-h-screen p-8">
            <div className="max-w-2xl mx-auto">
                <Link href={`/app/workspaces/${id}`} className="text-sm text-text-muted hover:text-text-secondary mb-2 block">
                    &larr; Back to {workspace.name}
                </Link>

                <div className="mb-8">
                    <h1 className="text-3xl font-bold">Git Workflow Configuration</h1>
                    <p className="text-text-muted mt-1">
                        Configure how agents should work with git in this workspace.
                    </p>
                </div>

                {/* Every health action is an admin write, so members do not see the card. */}
                {(access.role === 'owner' || access.role === 'admin') && (
                    <WorkspaceHealthCard
                        workspace={{ id: workspace.id, name: workspace.name, teamId: workspace.teamId }}
                        teams={userTeams.map(t => ({ id: t.id, name: t.name }))}
                        items={checkWorkspaceHealth({
                            name: workspace.name,
                            repo: workspace.repo,
                            configStatus: workspace.configStatus,
                            accessMode: workspace.accessMode,
                            gitConfig: workspace.gitConfig as Record<string, unknown> | null,
                            userTeamCount: userTeams.length,
                        })}
                    />
                )}

                <GitConfigForm
                    workspaceId={workspace.id}
                    workspaceName={workspace.name}
                    initialConfig={workspace.gitConfig as WorkspaceGitConfig | null}
                />

                <ConnectClaudeSection
                    workspaceId={workspace.id}
                    workspaceName={workspace.name}
                />

                <ReleaseSection
                    workspaceId={workspace.id}
                    teamId={workspace.teamId}
                    initialReleaseConfig={workspace.releaseConfig as WorkspaceReleaseConfig | null}
                    effectiveTrigger={resolveReleaseTrigger(workspace.releaseConfig as WorkspaceReleaseConfig | null)}
                    hasRepo={Boolean(workspace.repo)}
                />

                <BranchStrategySection
                    workspaceId={workspace.id}
                    effectiveBranchStrategy={resolveBranchStrategy(workspace.gitConfig as WorkspaceGitConfig | null)}
                    defaultBranch={(workspace.gitConfig as WorkspaceGitConfig | null)?.defaultBranch || 'main'}
                />

                <WorkTrackerSection
                    workspaceId={workspace.id}
                    initialWorkTrackerConfig={workspace.workTrackerConfig as WorkspaceWorkTrackerConfig | null}
                />

                <KnowledgeHealthSection workspaceId={workspace.id} />

                <SubjectPolicySection
                    workspaceId={workspace.id}
                    initialPolicy={(workspace.gitConfig as any)?.subjectPolicy ?? null}
                />
            </div>
        </main>
    );
}
