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
            <div className="border border-dashed border-border-default rounded-[10px] p-6">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-[8px] bg-surface-3 flex items-center justify-center flex-shrink-0">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </div>
                <div>
                  <p className="text-[13px] font-medium text-text-primary">No active workers</p>
                  <p className="text-[12px] text-text-muted mt-0.5">
                    Workers appear here when connected agents claim and start executing tasks. Create a task to get started.
                  </p>
                </div>
              </div>
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
