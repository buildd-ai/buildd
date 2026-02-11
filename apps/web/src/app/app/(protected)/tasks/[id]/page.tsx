import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { eq, desc } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { isStorageConfigured, generateDownloadUrl } from '@/lib/storage';
import ReassignButton from './ReassignButton';
import EditTaskButton from './EditTaskButton';
import DeleteTaskButton from './DeleteTaskButton';
import StartTaskButton from './StartTaskButton';
import RealTimeWorkerView from './RealTimeWorkerView';
import TaskAutoRefresh from './TaskAutoRefresh';
import MarkdownContent from '@/components/MarkdownContent';
import StatusBadge, { STATUS_COLORS } from '@/components/StatusBadge';

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

  // Verify access through team membership
  const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
  if (!access) {
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
    ['running', 'starting', 'waiting_input', 'awaiting_plan_approval'].includes(w.status)
  );

  // Override task status for UI if worker is waiting or awaiting plan
  const displayStatus = activeWorker?.status === 'waiting_input'
    ? 'waiting_input'
    : activeWorker?.status === 'awaiting_plan_approval'
      ? 'awaiting_plan_approval'
      : task.status;


  // Parse attachments from context — resolve R2 storage keys to presigned URLs
  const rawAttachments = (task.context as any)?.attachments as Array<{
    filename: string;
    mimeType: string;
    data?: string;
    storageKey?: string;
  }> | undefined;

  let attachments: Array<{ filename: string; mimeType: string; src: string }> | undefined;
  if (rawAttachments && rawAttachments.length > 0) {
    const storageReady = isStorageConfigured();
    attachments = await Promise.all(
      rawAttachments.map(async (att) => {
        if (att.storageKey && storageReady) {
          const url = await generateDownloadUrl(att.storageKey);
          return { filename: att.filename, mimeType: att.mimeType, src: url };
        }
        // Legacy inline base64
        return { filename: att.filename, mimeType: att.mimeType, src: att.data || '' };
      })
    );
  }

  const canReassign = task.status !== 'completed' && task.status !== 'pending';
  const canStart = task.status === 'pending';

  return (
    <div className="p-4 md:p-8 overflow-auto h-full">
      <div className="max-w-4xl">
        {/* Auto-refresh when worker claims this task */}
        <TaskAutoRefresh taskId={task.id} workspaceId={task.workspaceId} taskStatus={task.status} />

        {/* Breadcrumbs */}
        <nav aria-label="Breadcrumb" className="text-sm text-gray-500 mb-4">
          <Link href="/app/tasks" className="hover:text-gray-700 dark:hover:text-gray-300">Tasks</Link>
          <span className="mx-2">/</span>
          <span className="text-gray-900 dark:text-gray-100">{task.title}</span>
        </nav>

        {/* Header */}
        <div className="flex flex-col md:flex-row md:justify-between md:items-start gap-3 mb-6">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2 flex-wrap">
              <h1 className="text-xl md:text-2xl font-bold break-words">{task.title}</h1>
              <span data-testid="task-header-status" data-status={displayStatus}>
                <StatusBadge status={displayStatus} />
              </span>
            </div>
            <p className="text-gray-500 text-sm">
              {task.workspace?.name} &middot; Created {new Date(task.createdAt).toLocaleDateString()}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {canStart && <StartTaskButton taskId={task.id} workspaceId={task.workspaceId} />}
            <EditTaskButton
              task={{
                id: task.id,
                title: task.title,
                description: task.description,
                priority: task.priority,
              }}
            />
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
            <DeleteTaskButton taskId={task.id} taskStatus={task.status} />
          </div>
        </div>

        {/* Description */}
        {task.description && (
          <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
            <h2 className="text-sm font-medium text-gray-500 mb-2">Description</h2>
            <MarkdownContent content={task.description} />
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
                  <span className={`px-2 py-0.5 text-xs rounded-full ${STATUS_COLORS[task.parentTask.status] || STATUS_COLORS.pending}`}>
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
                        <span className={`px-2 py-0.5 text-xs rounded-full ${STATUS_COLORS[sub.status] || STATUS_COLORS.pending}`}>
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
                      src={att.src}
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

        {/* Active Worker - Real-time updates */}
        {activeWorker && (
          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full border-2 border-green-500 border-t-transparent animate-spin" aria-hidden="true"></span>
              Active Worker
            </h2>
            <RealTimeWorkerView
              initialWorker={{
                id: activeWorker.id,
                name: activeWorker.name,
                branch: activeWorker.branch,
                status: activeWorker.status,
                currentAction: activeWorker.currentAction,
                milestones: (activeWorker.milestones as any[]) || [],
                turns: activeWorker.turns,
                costUsd: activeWorker.costUsd?.toString() || null,
                inputTokens: activeWorker.inputTokens,
                outputTokens: activeWorker.outputTokens,
                startedAt: activeWorker.startedAt?.toISOString() || null,
                prUrl: activeWorker.prUrl,
                prNumber: activeWorker.prNumber,
                localUiUrl: activeWorker.localUiUrl,
                commitCount: activeWorker.commitCount,
                filesChanged: activeWorker.filesChanged,
                linesAdded: activeWorker.linesAdded,
                linesRemoved: activeWorker.linesRemoved,
                lastCommitSha: activeWorker.lastCommitSha,
                waitingFor: activeWorker.waitingFor as any,
                instructionHistory: (activeWorker.instructionHistory as any[]) || [],
                pendingInstructions: activeWorker.pendingInstructions,
                account: activeWorker.account ? { authType: activeWorker.account.authType } : null,
              }}
            />
          </div>
        )}

        {/* Deliverables */}
        {(task.result as any) && (
          (() => {
            const result = task.result as { summary?: string; branch?: string; commits?: number; sha?: string; files?: number; added?: number; removed?: number; prUrl?: string; prNumber?: number };
            return (
              <div className="mb-8 p-4 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-lg">
                <h2 className="text-sm font-medium text-green-700 dark:text-green-400 mb-2">Deliverables</h2>
                <div className="flex items-center gap-3 text-sm flex-wrap">
                  {result.branch && (
                    <code className="px-2 py-0.5 bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300 rounded text-xs">
                      {result.branch}
                    </code>
                  )}
                  {(result.commits ?? 0) > 0 && (
                    <span className="text-gray-600 dark:text-gray-400 text-xs">
                      {result.commits} commit{result.commits !== 1 ? 's' : ''}
                    </span>
                  )}
                  {((result.added ?? 0) > 0 || (result.removed ?? 0) > 0) && (
                    <span className="text-xs">
                      <span className="text-green-600">+{result.added}</span>
                      <span className="text-red-500">/{'-'}{result.removed}</span>
                    </span>
                  )}
                  {(result.files ?? 0) > 0 && (
                    <span className="text-xs text-gray-500">{result.files} files</span>
                  )}
                  {result.sha && (
                    <code className="text-xs text-gray-400">{result.sha.slice(0, 7)}</code>
                  )}
                  {result.prUrl && (
                    <a
                      href={result.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-2 py-0.5 text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 rounded-full hover:bg-green-200 dark:hover:bg-green-800"
                    >
                      PR #{result.prNumber}
                    </a>
                  )}
                </div>
                {result.summary && (
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">{result.summary}</p>
                )}
              </div>
            );
          })()
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
                        <span className={`px-2 py-0.5 text-xs rounded-full ${STATUS_COLORS[worker.status] || STATUS_COLORS.pending}`}>
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
                        <span title={worker.startedAt ? new Date(worker.startedAt).toString() : undefined}>
                          Started: {worker.startedAt ? new Date(worker.startedAt).toLocaleString(undefined, {
                            dateStyle: 'short',
                            timeStyle: 'medium'
                          }) : '-'}
                        </span>
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
                          className={`px-3 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800${/^https?:\/\/(localhost|127\.0\.0\.1)/.test(worker.localUiUrl) ? ' hidden sm:inline-block' : ''}`}
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
            <p className="text-gray-500 mb-2">This task is waiting to be started</p>
            <p className="text-sm text-gray-400 mb-4">
              Click &quot;Start Task&quot; above to assign it to a worker, or wait for a worker to claim it automatically.
            </p>
            <StartTaskButton taskId={task.id} workspaceId={task.workspaceId} />
          </div>
        )}
      </div>
    </div>
  );
}
