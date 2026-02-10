import { db } from '@buildd/core/db';
import { workspaces, type WorkspaceGitConfig } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { GitConfigForm } from './GitConfigForm';
import { verifyWorkspaceAccess } from '@/lib/team-access';

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
            gitConfig: true,
            configStatus: true,
        },
    });

    if (!workspace) {
        notFound();
    }
    if (isDev) {
        return (
            <main className="min-h-screen p-8">
                <div className="max-w-2xl mx-auto">
                    <p className="text-gray-500">Development mode - no database</p>
                </div>
            </main>
        );
    }

    return (
        <main className="min-h-screen p-8">
            <div className="max-w-2xl mx-auto">
                <Link href={`/app/workspaces/${id}`} className="text-sm text-gray-500 hover:text-gray-700 mb-2 block">
                    &larr; Back to {workspace.name}
                </Link>

                <div className="mb-8">
                    <h1 className="text-3xl font-bold">Git Workflow Configuration</h1>
                    <p className="text-gray-500 mt-1">
                        Configure how agents should work with git in this workspace.
                    </p>
                </div>

                <GitConfigForm
                    workspaceId={workspace.id}
                    workspaceName={workspace.name}
                    initialConfig={workspace.gitConfig as WorkspaceGitConfig | null}
                    configStatus={workspace.configStatus as 'unconfigured' | 'admin_confirmed'}
                />
            </div>
        </main>
    );
}
