import { db } from '@buildd/core/db';
import { workspaces, type WorkspaceGitConfig } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { GitConfigForm } from './GitConfigForm';
import { TeamTransferSection } from './TeamTransferSection';
import { verifyWorkspaceAccess, getUserTeamsWithDetails } from '@/lib/team-access';
import { PageContent } from '@/components/PageContent';

export default async function WorkspaceConfigPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    const isDev = process.env.NODE_ENV === 'development';
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
        },
    });

    const userTeams = await getUserTeamsWithDetails(user.id);

    if (!workspace) {
        notFound();
    }
    if (isDev) {
        return (
            <PageContent>
                    <p className="text-text-muted">Development mode - no database</p>
            </PageContent>
        );
    }

    return (
        <PageContent>
                <Link href={`/app/workspaces/${id}`} className="text-sm text-text-muted hover:text-text-secondary mb-2 block">
                    &larr; Back to {workspace.name}
                </Link>

                <div className="mb-8">
                    <h1 className="text-3xl font-bold">Git Workflow Configuration</h1>
                    <p className="text-text-muted mt-1">
                        Configure how agents should work with git in this workspace.
                    </p>
                </div>

                <GitConfigForm
                    workspaceId={workspace.id}
                    workspaceName={workspace.name}
                    initialConfig={workspace.gitConfig as WorkspaceGitConfig | null}
                    configStatus={workspace.configStatus as 'unconfigured' | 'admin_confirmed'}
                />

                {userTeams.length > 1 && (
                    <TeamTransferSection
                        workspaceId={workspace.id}
                        currentTeamId={workspace.teamId}
                        teams={userTeams}
                    />
                )}
        </PageContent>
    );
}
