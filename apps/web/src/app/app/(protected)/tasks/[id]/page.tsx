import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { eq, desc, and } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import ReassignButton from './ReassignButton';
import EditTaskButton from './EditTaskButton';
import DeleteTaskButton from './DeleteTaskButton';
import InstructWorkerForm from './InstructWorkerForm';
import WorkerActivityTimeline from './WorkerActivityTimeline';
import InstructionHistory from './InstructionHistory';

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const isDev = process.env.NODE_ENV === 'development';
  const user = await getCurrentUser();

  if (isDev) {
    return (
      <div className="p-8">
        <div className="max-w-4xl">
          <p className="text-gray-500">Development mode - no database</p>
        </div>
      </div>
    );
  }

  if (!user) {
    redirect('/app/auth/signin');
  }

  // Get task with workspace (for ownership check) and relationships
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, id),
    with: {
      workspace: true,
      account: true,
      parentTask: { columns: { id: true, title: true, status: true } },
      subTasks: { columns: { id: true, title: true, status: true } },
    },
  });

  if (!task) {
    notFound();
  }

  // Verify ownership through workspace
  if (task.workspace?.ownerId !== user.id) {
    notFound();
  }

  // Get workers for this task
  const taskWorkers = await db.query.workers.findMany({
    where: eq(workers.taskId, id),
    orderBy: desc(workers.createdAt),
    with: {
      account: true,
    },
  });

  // Get the active worker (if any)
  const activeWorker = taskWorkers.find(w =>
    ['running', 'starting', 'waiting_input'].includes(w.status)
  );

  const statusColors: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
    assigned: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    running: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    completed: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
    failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  };

  const workerStatusColors: Record<string, string> = {
    idle: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
    starting: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    running: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    waiting_input: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
    completed: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
    failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  };

  // Parse attachments from context
  const attachments = (task.context as any)?.attachments as Array<{
    filename: string;
    mimeType: string;
    data: string;
  }> | undefined;

  const canReassign = task.status !== 'completed' && task.status !== 'pending';

  return (
    <div className="p-8 overflow-auto h-full">
      <div className="max-w-4xl">
        {/* Header */}
        <div className="flex justify-between items-start mb-6">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-2xl font-bold">{task.title}</h1>
              <span className={`px-3 py-1 text-sm rounded-full ${statusColors[task.status] || statusColors.pending}`}>
                {task.status}
              </span>
            </div>
            <p className="text-gray-500 text-sm">
              {task.workspace?.name} &middot; Created {new Date(task.createdAt).toLocaleDateString()}
            </p>
          </div>
          <div className="flex gap-2">
            <EditTaskButton
              task={{
                id: task.id,
                title: task.title,
                description: task.description,
                priority: task.priority,
              }}
            />
            <DeleteTaskButton taskId={task.id} taskStatus={task.status} />
            {canReassign && <ReassignButton taskId={task.id} />}
            {task.externalUrl && (
              <a
                href={task.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                View Source
              </a>
            )}
          </div>
        </div>

        {/* Description */}
        {task.description && (
          <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
            <h2 className="text-sm font-medium text-gray-500 mb-2">Description</h2>
            <p className="whitespace-pre-wrap">{task.description}</p>
          </div>
        )}

        {/* Task Relationships */}
        {(task.parentTask || (task.subTasks && task.subTasks.length > 0)) && (
          <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
            <h2 className="text-sm font-medium text-gray-500 mb-3">Related Tasks</h2>
            <div className="space-y-3">
              {task.parentTask && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400">Parent:</span>
                  <Link
                    href={`/app/tasks/${task.parentTask.id}`}
                    className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {task.parentTask.title}
                  </Link>
                  <span className={`px-2 py-0.5 text-xs rounded-full ${statusColors[task.parentTask.status] || statusColors.pending}`}>
                    {task.parentTask.status}
                  </span>
                </div>
              )}
              {task.subTasks && task.subTasks.length > 0 && (
                <div>
                  <span className="text-xs text-gray-400">Subtasks ({task.subTasks.length}):</span>
                  <div className="mt-2 space-y-1 ml-4">
                    {task.subTasks.map((sub: { id: string; title: string; status: string }) => (
                      <div key={sub.id} className="flex items-center gap-2">
                        <Link
                          href={`/app/tasks/${sub.id}`}
                          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          {sub.title}
                        </Link>
                        <span className={`px-2 py-0.5 text-xs rounded-full ${statusColors[sub.status] || statusColors.pending}`}>
                          {sub.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Attachments */}
        {attachments && attachments.length > 0 && (
          <div className="mb-6">
            <h2 className="text-sm font-medium text-gray-500 mb-2">Attachments</h2>
            <div className="flex flex-wrap gap-2">
              {attachments.map((att, i) => (
                <div key={i} className="relative">
                  {att.mimeType.startsWith('image/') ? (
                    <img
                      src={att.data}
                      alt={att.filename}
                      className="max-h-32 rounded border border-gray-200 dark:border-gray-700"
                    />
                  ) : (
                    <div className="p-3 bg-gray-100 dark:bg-gray-800 rounded">
                      <span className="text-sm">{att.filename}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Task Details */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="p-4 border border-gray-200 dark:border-gray-800 rounded-lg">
            <div className="text-sm text-gray-500">Priority</div>
            <div className="text-xl font-semibold">{task.priority}</div>
          </div>
          <div className="p-4 border border-gray-200 dark:border-gray-800 rounded-lg">
            <div className="text-sm text-gray-500">Runner Preference</div>
            <div className="text-xl font-semibold">{task.runnerPreference}</div>
          </div>
          <div className="p-4 border border-gray-200 dark:border-gray-800 rounded-lg">
            <div className="text-sm text-gray-500">Claimed By</div>
            <div className="text-xl font-semibold">{task.account?.name || '-'}</div>
          </div>
          <div className="p-4 border border-gray-200 dark:border-gray-800 rounded-lg">
            <div className="text-sm text-gray-500">Workers</div>
            <div className="text-xl font-semibold">{taskWorkers.length}</div>
          </div>
        </div>

        {/* Active Worker */}
        {activeWorker && (
          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
              Active Worker
            </h2>
            <div className="border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30 rounded-lg p-4">
              <div className="flex justify-between items-start mb-3">
                <div>
                  <h3 className="font-medium text-lg">{activeWorker.name}</h3>
                  <p className="text-sm text-gray-500">Branch: {activeWorker.branch}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-1 text-xs rounded-full ${workerStatusColors[activeWorker.status]}`}>
                    {activeWorker.status}
                  </span>
                  {activeWorker.localUiUrl && (
                    <a
                      href={`${activeWorker.localUiUrl}/worker/${activeWorker.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3 py-1 text-xs bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 rounded-full hover:bg-blue-200 dark:hover:bg-blue-800"
                    >
                      Open Terminal
                    </a>
                  )}
                </div>
              </div>

              {/* Current action (only for MCP workers - local-ui shows in timeline) */}
              {!activeWorker.localUiUrl && activeWorker.currentAction && (
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                  {activeWorker.currentAction}
                </p>
              )}

              {/* Progress bar */}
              {activeWorker.progress > 0 && (
                <div className="mb-3">
                  <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-green-500 transition-all"
                      style={{ width: `${activeWorker.progress}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Activity Timeline (rich view for local-ui workers) */}
              {activeWorker.localUiUrl ? (
                <WorkerActivityTimeline
                  milestones={(activeWorker.milestones as any[]) || []}
                  currentAction={activeWorker.currentAction}
                />
              ) : (
                /* Simple milestone boxes for MCP workers */
                activeWorker.milestones && (activeWorker.milestones as any[]).length > 0 && (
                  <div className="flex items-center gap-1 mt-2">
                    {Array.from({ length: Math.min((activeWorker.milestones as any[]).length, 10) }).map((_, i) => (
                      <div key={i} className="w-6 h-2 bg-blue-500 rounded-sm" />
                    ))}
                    {Array.from({ length: Math.max(0, 10 - (activeWorker.milestones as any[]).length) }).map((_, i) => (
                      <div key={i} className="w-6 h-2 bg-gray-200 dark:bg-gray-700 rounded-sm" />
                    ))}
                    <span className="text-xs text-gray-500 ml-2">
                      {(activeWorker.milestones as any[]).length} milestones
                    </span>
                  </div>
                )
              )}

              <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
                <span>Turns: {activeWorker.turns}</span>
                {activeWorker.account?.authType === 'oauth' ? (
                  // Seat-based: show tokens instead of cost
                  <span>
                    {((activeWorker.inputTokens || 0) + (activeWorker.outputTokens || 0)).toLocaleString()} tokens
                  </span>
                ) : (
                  // API-based: show cost
                  <span>Cost: ${parseFloat(activeWorker.costUsd?.toString() || '0').toFixed(4)}</span>
                )}
                {activeWorker.startedAt && (
                  <span>
                    {Math.round((Date.now() - new Date(activeWorker.startedAt).getTime()) / 60000)}m elapsed
                  </span>
                )}
                {activeWorker.prUrl && (
                  <a
                    href={activeWorker.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-green-600 hover:underline"
                  >
                    PR #{activeWorker.prNumber}
                  </a>
                )}
              </div>

              {/* Git stats */}
              {((activeWorker.commitCount ?? 0) > 0 || (activeWorker.filesChanged ?? 0) > 0) && (
                <div className="flex items-center gap-4 mt-2 text-xs">
                  {(activeWorker.commitCount ?? 0) > 0 && (
                    <span className="text-gray-500">
                      {activeWorker.commitCount} commit{activeWorker.commitCount !== 1 ? 's' : ''}
                    </span>
                  )}
                  {(activeWorker.filesChanged ?? 0) > 0 && (
                    <span className="text-gray-500">
                      {activeWorker.filesChanged} file{activeWorker.filesChanged !== 1 ? 's' : ''}
                    </span>
                  )}
                  {((activeWorker.linesAdded ?? 0) > 0 || (activeWorker.linesRemoved ?? 0) > 0) && (
                    <span>
                      <span className="text-green-600">+{activeWorker.linesAdded ?? 0}</span>
                      {' / '}
                      <span className="text-red-500">-{activeWorker.linesRemoved ?? 0}</span>
                    </span>
                  )}
                  {activeWorker.lastCommitSha && (
                    <span className="text-gray-400 font-mono">
                      {activeWorker.lastCommitSha.slice(0, 7)}
                    </span>
                  )}
                </div>
              )}

              {/* Instruction history and input */}
              <InstructionHistory
                history={(activeWorker.instructionHistory as any[]) || []}
                pendingInstruction={activeWorker.pendingInstructions}
              />
              <InstructWorkerForm
                workerId={activeWorker.id}
                pendingInstructions={null} // History component handles pending display
              />
            </div>
          </div>
        )}

        {/* Worker History */}
        {taskWorkers.length > 0 && (
          <div>
            <h2 className="text-xl font-semibold mb-4">Worker History</h2>
            <div className="border border-gray-200 dark:border-gray-800 rounded-lg divide-y divide-gray-200 dark:divide-gray-800">
              {taskWorkers.map((worker) => (
                <div key={worker.id} className="p-4">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium">{worker.name}</h3>
                        <span className={`px-2 py-0.5 text-xs rounded-full ${workerStatusColors[worker.status]}`}>
                          {worker.status}
                        </span>
                      </div>
                      <p className="text-sm text-gray-500">
                        Branch: {worker.branch}
                        {worker.account && ` • ${worker.account.name}`}
                      </p>
                      {worker.error && (
                        <p className="text-sm text-red-500 mt-1">{worker.error}</p>
                      )}
                      <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                        <span>Started: {worker.startedAt ? new Date(worker.startedAt).toLocaleString() : '-'}</span>
                        <span>Turns: {worker.turns}</span>
                        <span>Cost: ${parseFloat(worker.costUsd?.toString() || '0').toFixed(4)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {worker.prUrl && (
                        <a
                          href={worker.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-1 text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 rounded-full hover:bg-green-200 dark:hover:bg-green-800"
                        >
                          PR #{worker.prNumber}
                        </a>
                      )}
                      {worker.localUiUrl && (
                        <a
                          href={`${worker.localUiUrl}/worker/${worker.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800"
                        >
                          View
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {taskWorkers.length === 0 && task.status === 'pending' && (
          <div className="border border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-8 text-center">
            <p className="text-gray-500 mb-2">Waiting for a worker to claim this task</p>
            <p className="text-sm text-gray-400">
              Workers will appear here once they start working on this task
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
