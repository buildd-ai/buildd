import WarmHandoverSection from '@/components/WarmHandoverSection';
import { db } from '@buildd/core/db';
import { workspaces, type WorkspaceGitConfig, type WorkspaceReleaseConfig, type WorkspaceWorkTrackerConfig } from '@buildd/core/db/schema';
import { resolveReleaseTrigger } from '@buildd/core/release-strategy';
import { resolveBranchStrategy } from '@buildd/core/branch-strategy';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { appBaseUrl } from '@/lib/app-url';
import { GitConfigForm } from './GitConfigForm';
import { WorkspaceHealthCard } from './WorkspaceHealthCard';
import { ReadinessCard } from './ReadinessCard';
import { RepoAccessCard } from './RepoAccessCard';
import { getRepoAccessView } from '@/lib/github-repo-access-store';
import { checkWorkspaceHealth } from '@/lib/workspace-health';
import ConnectClaudeSection from './ConnectClaudeSection';
import ReleaseSection from './ReleaseSection';
import BranchStrategySection from './BranchStrategySection';
import WorkTrackerSection from './WorkTrackerSection';
import KnowledgeHealthSection from './KnowledgeHealthSection';
import SubjectPolicySection from './SubjectPolicySection';
import ExecutorSection from './ExecutorSection';
import RunnerSizeSection from './RunnerSizeSection';
import CiRetrySection from './CiRetrySection';
import ConcurrencySection from './ConcurrencySection';
import { isRunnerSize, isWorkspaceExecutor, resolveWorkspaceExecutor } from '@buildd/shared';
import { resolveWorkspaceRunnerSize } from '@/lib/runner-size-store';
import { workspaceHostedRunnerMonth } from '@/lib/hosted-runner-usage-store';
import { workspaceRunnerMonthLine } from '@/lib/hosted-runner-usage';
import { verifyWorkspaceAccess, getUserTeamsWithDetails } from '@/lib/team-access';
import DeleteWorkspaceButton from '../DeleteWorkspaceButton';
import { roleHas } from '@/lib/permission-registry';
import { getTeamPermissionOverrides } from '@/lib/permissions';

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
    const overrides = await getTeamPermissionOverrides(access.teamId);

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
            webhookConfig: true,
            maxConcurrentTasks: true,
        },
    });

    const userTeams = await getUserTeamsWithDetails(user.id);
    // Read-only diagnosis; a failure here must not take the settings page down.
    const repoAccessView = await getRepoAccessView(id, user.id).catch((err) => {
        console.error('[workspace-config] repo access view failed:', err);
        return null;
    });
    const canManageSettings = roleHas(access.role, 'manage_workspace_settings', overrides);

    if (!workspace) {
        notFound();
    }

    // Where its tasks run: the stored value and the one the claim route applies.
    const storedExecutor = (workspace.gitConfig as { executor?: unknown } | null)?.executor;
    const executor = resolveWorkspaceExecutor(workspace.gitConfig as { executor?: unknown } | null, workspace.webhookConfig);
    // Cloud container size: only where cloud runs can take its tasks. Read-only
    // here; the dispatch route is the one that stores a fresh derivation.
    const storedRunnerSize = (workspace.gitConfig as { runnerSize?: unknown } | null)?.runnerSize;
    const runnerSize = executor.executor === 'host' ? null : await resolveWorkspaceRunnerSize(workspace);
    const runnerMonth = runnerSize ? await workspaceHostedRunnerMonth(workspace.id).catch(() => null) : null;

    return (
        <main className="min-h-screen p-4 md:p-8">
            <div className="max-w-2xl mx-auto">
                <Link href={`/app/workspaces/${id}`} className="text-sm text-text-muted hover:text-text-secondary mb-2 block">
                    &larr; Back to {workspace.name}
                </Link>

                <div className="mb-8">
                    <h1 className="text-2xl md:text-3xl font-bold">Git Workflow Configuration</h1>
                    <p className="text-text-muted mt-1">
                        Set how agents use git in this workspace.
                    </p>
                </div>

                {/* Every health action is an admin write, so members do not see the card. */}
                {roleHas(access.role, 'manage_workspace_settings', overrides) && (
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

                {/* Scaffold and spec routes are admin writes too. */}
                {roleHas(access.role, 'manage_workspace_settings', overrides) && (
                    <ReadinessCard workspaceId={workspace.id} />
                )}

                {/* Members see what is missing and who to ask; only admins get Check connection. */}
                {repoAccessView && (!repoAccessView.ok || canManageSettings) && (
                    <RepoAccessCard
                        workspaceId={workspace.id}
                        initialView={repoAccessView}
                        canCheck={canManageSettings}
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
                    serverOrigin={appBaseUrl()}
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

                <ExecutorSection
                    workspaceId={workspace.id}
                    explicit={isWorkspaceExecutor(storedExecutor) ? storedExecutor : null}
                    effective={executor.executor}
                    source={executor.source}
                />

                {runnerSize && (
                    <RunnerSizeSection
                        workspaceId={workspace.id}
                        explicit={isRunnerSize(storedRunnerSize) ? storedRunnerSize : null}
                        effective={runnerSize.size}
                        source={runnerSize.source}
                        reason={runnerSize.reason}
                        monthLine={runnerMonth && runnerMonth.wallSeconds > 0 ? workspaceRunnerMonthLine(runnerMonth) : null}
                    />
                )}

                <WarmHandoverSection workspaceId={workspace.id} teamId={workspace.teamId} initial={(workspace.gitConfig as WorkspaceGitConfig | null)?.warmHandover ?? null} canEdit={roleHas(access.role, 'manage_workspace_settings', overrides)} />

                <CiRetrySection
                    workspaceId={workspace.id}
                    initial={(workspace.gitConfig as WorkspaceGitConfig | null)?.enforceGreenCI === true}
                    canEdit={roleHas(access.role, 'manage_workspace_settings', overrides)}
                />

                <ConcurrencySection
                    workspaceId={workspace.id}
                    initialMaxConcurrentTasks={workspace.maxConcurrentTasks}
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

                {/* Destructive action lives here, away from the workspace header's primary actions.
                    DELETE is owner-only, so other roles would get a button that always fails. */}
                {roleHas(access.role, 'delete_workspace', overrides) && (
                    <section
                        data-testid="workspace-danger-zone"
                        className="mt-10 border border-status-error/30 rounded-lg p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                        <div className="min-w-0">
                            <h2 className="text-sm font-semibold text-status-error">Delete workspace</h2>
                            <p className="text-xs text-text-muted mt-1">
                                Deletes the workspace and its tasks and workers. You can&apos;t undo this.
                            </p>
                        </div>
                        <DeleteWorkspaceButton workspaceId={workspace.id} workspaceName={workspace.name} />
                    </section>
                )}
            </div>
        </main>
    );
}
