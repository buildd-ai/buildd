import { db } from '@buildd/core/db';
import { workers, tasks, workspaces } from '@buildd/core/db/schema';
import { desc, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';

export default async function WorkersPage() {
  const isDev = process.env.NODE_ENV === 'development';
  const user = await getCurrentUser();

  let allWorkers: (typeof workers.$inferSelect & { task: typeof tasks.$inferSelect | null })[] = [];

  if (!isDev) {
    if (!user) {
      redirect('/app/auth/signin');
    }

    try {
      // Get user's workspace IDs via team membership
      const workspaceIds = await getUserWorkspaceIds(user.id);

      if (workspaceIds.length > 0) {
        allWorkers = await db.query.workers.findMany({
          where: inArray(workers.workspaceId, workspaceIds),
          orderBy: desc(workers.createdAt),
          with: { task: true },
        }) as any;
      }
    } catch (error) {
      console.error('Workers query error:', error);
    }
  }

  const statusColors: Record<string, string> = {
    idle: 'bg-surface-3 text-text-primary',
    starting: 'bg-status-info/10 text-status-info',
    running: 'bg-status-success/10 text-status-success',
    waiting_input: 'bg-status-running/10 text-status-running',
    completed: 'bg-surface-3 text-text-primary',
    failed: 'bg-status-error/10 text-status-error',
  };

  const activeWorkers = allWorkers.filter(w => ['running', 'starting', 'waiting_input'].includes(w.status));
  const completedWorkers = allWorkers.filter(w => !['running', 'starting', 'waiting_input'].includes(w.status));

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <Link href="/app/dashboard" className="text-sm text-text-secondary hover:text-text-primary mb-2 block">
            ← Dashboard
          </Link>
          <h1 className="text-3xl font-bold">Workers</h1>
          <p className="text-text-secondary">Agents executing tasks</p>
        </div>

        {/* Active Workers */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <span className="w-2 h-2 bg-status-success rounded-full animate-pulse"></span>
            Active ({activeWorkers.length})
          </h2>

          {activeWorkers.length === 0 ? (
            <div className="border border-dashed border-border-default rounded-lg p-8 text-center">
              <p className="text-text-secondary">No active workers</p>
              <p className="text-sm text-text-muted mt-2">
                Workers appear here when agents claim tasks
              </p>
            </div>
          ) : (
            <div className="border border-border-default rounded-lg divide-y divide-border-default">
              {activeWorkers.map((worker) => (
                <div key={worker.id} className="p-4">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <h3 className="font-medium">{worker.name}</h3>
                      <p className="text-sm text-text-secondary">{worker.task?.title || 'No task'}</p>
                      <div className="flex items-center gap-4 mt-2 text-xs text-text-muted">
                        <span>Branch: {worker.branch}</span>
                        <span>Turns: {worker.turns}</span>
                        <span>Cost: ${parseFloat(worker.costUsd?.toString() || '0').toFixed(4)}</span>
                      </div>
                    </div>
                    <span className={`px-2 py-1 text-xs rounded-full ml-4 ${statusColors[worker.status] || statusColors.idle}`}>
                      {worker.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Completed Workers */}
        {completedWorkers.length > 0 && (
          <div>
            <h2 className="text-xl font-semibold mb-4">
              Completed ({completedWorkers.length})
            </h2>

            <div className="border border-border-default rounded-lg divide-y divide-border-default">
              {completedWorkers.slice(0, 20).map((worker) => (
                <div key={worker.id} className="p-4">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <h3 className="font-medium">{worker.name}</h3>
                      <p className="text-sm text-text-secondary">{worker.task?.title || 'No task'}</p>
                      <div className="flex items-center gap-4 mt-2 text-xs text-text-muted">
                        <span>Turns: {worker.turns}</span>
                        <span>Cost: ${parseFloat(worker.costUsd?.toString() || '0').toFixed(4)}</span>
                        {worker.error && <span className="text-status-error">Error: {worker.error.slice(0, 50)}</span>}
                      </div>
                    </div>
                    <span className={`px-2 py-1 text-xs rounded-full ml-4 ${statusColors[worker.status] || statusColors.idle}`}>
                      {worker.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
