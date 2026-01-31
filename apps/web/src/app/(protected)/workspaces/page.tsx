import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { desc } from 'drizzle-orm';
import Link from 'next/link';

interface WorkspaceWithRunners {
  id: string;
  name: string;
  repo: string | null;
  localPath: string | null;
  createdAt: Date;
  runners: {
    action: boolean;
    service: boolean;
    user: boolean;
  };
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
    </svg>
  );
}

export default async function WorkspacesPage() {
  const isDev = process.env.NODE_ENV === 'development';

  let allWorkspaces: WorkspaceWithRunners[] = [];

  if (!isDev) {
    try {
      const rawWorkspaces = await db.query.workspaces.findMany({
        orderBy: desc(workspaces.createdAt),
        with: {
          accountWorkspaces: {
            with: {
              account: true,
            },
          },
        },
      });

      allWorkspaces = rawWorkspaces.map((ws) => {
        const connectedAccounts = ws.accountWorkspaces || [];
        return {
          id: ws.id,
          name: ws.name,
          repo: ws.repo,
          localPath: ws.localPath,
          createdAt: ws.createdAt,
          runners: {
            action: connectedAccounts.some((aw) => aw.account?.type === 'action' && aw.canClaim),
            service: connectedAccounts.some((aw) => aw.account?.type === 'service' && aw.canClaim),
            user: connectedAccounts.some((aw) => aw.account?.type === 'user' && aw.canClaim),
          },
        };
      });
    } catch (error) {
      console.error('Workspaces query error:', error);
    }
  }

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <div>
            <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-700 mb-2 block">
              ← Dashboard
            </Link>
            <h1 className="text-3xl font-bold">Workspaces</h1>
          </div>
          <Link
            href="/workspaces/new"
            className="px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80"
          >
            + New Workspace
          </Link>
        </div>

        {allWorkspaces.length === 0 ? (
          <div className="border border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-12 text-center">
            <h2 className="text-xl font-semibold mb-2">No workspaces yet</h2>
            <p className="text-gray-500 mb-6">
              Connect a GitHub repository to start creating tasks
            </p>
            <Link
              href="/workspaces/new"
              className="px-6 py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80"
            >
              Create Workspace
            </Link>
          </div>
        ) : (
          <div className="border border-gray-200 dark:border-gray-800 rounded-lg divide-y divide-gray-200 dark:divide-gray-800">
            {allWorkspaces.map((workspace) => (
              <Link
                key={workspace.id}
                href={`/workspaces/${workspace.id}`}
                className="block p-4 hover:bg-gray-50 dark:hover:bg-gray-900"
              >
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <h3 className="font-medium">{workspace.name}</h3>
                    {workspace.repo && (
                      <p className="text-sm text-gray-500">{workspace.repo}</p>
                    )}
                  </div>
                  <div className="flex gap-3 items-center text-xs">
                    <div className={`flex items-center gap-1 ${workspace.runners.action ? 'text-green-600 dark:text-green-400' : 'text-gray-400'}`} title="GitHub Actions">
                      {workspace.runners.action ? <CheckIcon /> : <XIcon />}
                      <span>GH Action</span>
                    </div>
                    <div className={`flex items-center gap-1 ${workspace.runners.service ? 'text-green-600 dark:text-green-400' : 'text-gray-400'}`} title="Service Worker">
                      {workspace.runners.service ? <CheckIcon /> : <XIcon />}
                      <span>Service</span>
                    </div>
                    <div className={`flex items-center gap-1 ${workspace.runners.user ? 'text-green-600 dark:text-green-400' : 'text-gray-400'}`} title="User Worker">
                      {workspace.runners.user ? <CheckIcon /> : <XIcon />}
                      <span>User</span>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
