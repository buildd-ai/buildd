import { db } from '@buildd/core/db';
import { workers, tasks } from '@buildd/core/db/schema';
import { desc } from 'drizzle-orm';
import Link from 'next/link';

export default async function WorkersPage() {
  const isDev = process.env.NODE_ENV === 'development';

  let allWorkers: (typeof workers.$inferSelect & { task: typeof tasks.$inferSelect | null })[] = [];

  if (!isDev) {
    try {
      allWorkers = await db.query.workers.findMany({
        orderBy: desc(workers.createdAt),
        with: { task: true },
      }) as any;
    } catch (error) {
      console.error('Workers query error:', error);
    }
  }

  const statusColors: Record<string, string> = {
    idle: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
    starting: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    running: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    waiting_input: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
    completed: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
    failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  };

  const activeWorkers = allWorkers.filter(w => ['running', 'starting', 'waiting_input'].includes(w.status));
  const completedWorkers = allWorkers.filter(w => !['running', 'starting', 'waiting_input'].includes(w.status));

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-700 mb-2 block">
            ← Dashboard
          </Link>
          <h1 className="text-3xl font-bold">Workers</h1>
          <p className="text-gray-500">Agents executing tasks</p>
        </div>

        {/* Active Workers */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
            Active ({activeWorkers.length})
          </h2>

          {activeWorkers.length === 0 ? (
            <div className="border border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-8 text-center">
              <p className="text-gray-500">No active workers</p>
              <p className="text-sm text-gray-400 mt-2">
                Workers appear here when agents claim tasks
              </p>
            </div>
          ) : (
            <div className="border border-gray-200 dark:border-gray-800 rounded-lg divide-y divide-gray-200 dark:divide-gray-800">
              {activeWorkers.map((worker) => (
                <div key={worker.id} className="p-4">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <h3 className="font-medium">{worker.name}</h3>
                      <p className="text-sm text-gray-500">{worker.task?.title || 'No task'}</p>
                      <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                        <span>Branch: {worker.branch}</span>
                        <span>Turns: {worker.turns}</span>
                        <span>Cost: ${parseFloat(worker.costUsd?.toString() || '0').toFixed(4)}</span>
                      </div>
                      {worker.progress > 0 && (
                        <div className="mt-2 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-green-500 transition-all"
                            style={{ width: `${worker.progress}%` }}
                          />
                        </div>
                      )}
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

            <div className="border border-gray-200 dark:border-gray-800 rounded-lg divide-y divide-gray-200 dark:divide-gray-800">
              {completedWorkers.slice(0, 20).map((worker) => (
                <div key={worker.id} className="p-4">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <h3 className="font-medium">{worker.name}</h3>
                      <p className="text-sm text-gray-500">{worker.task?.title || 'No task'}</p>
                      <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                        <span>Turns: {worker.turns}</span>
                        <span>Cost: ${parseFloat(worker.costUsd?.toString() || '0').toFixed(4)}</span>
                        {worker.error && <span className="text-red-500">Error: {worker.error.slice(0, 50)}</span>}
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
