import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { desc } from 'drizzle-orm';
import Link from 'next/link';

export default async function WorkspacesPage() {
  const isDev = process.env.NODE_ENV === 'development';

  let allWorkspaces: typeof workspaces.$inferSelect[] = [];

  if (!isDev) {
    try {
      allWorkspaces = await db.query.workspaces.findMany({
        orderBy: desc(workspaces.createdAt),
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
                  <div>
                    <h3 className="font-medium">{workspace.name}</h3>
                    {workspace.repo && (
                      <p className="text-sm text-gray-500">{workspace.repo}</p>
                    )}
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
