import { db } from '@buildd/core/db';
import { tasks, workers, workspaces, artifacts } from '@buildd/core/db/schema';
import { eq, desc, inArray, sql } from 'drizzle-orm';
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

const CATEGORY_COLORS: Record<string, string> = {
  bug: 'bg-cat-bug/15 text-cat-bug',
  feature: 'bg-cat-feature/15 text-cat-feature',
  refactor: 'bg-cat-refactor/15 text-cat-refactor',
  chore: 'bg-cat-chore/15 text-cat-chore',
  docs: 'bg-cat-docs/15 text-cat-docs',
  test: 'bg-cat-test/15 text-cat-test',
  infra: 'bg-cat-infra/15 text-cat-infra',
  design: 'bg-cat-design/15 text-cat-design',
};

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
          <p className="text-text-secondary">Development mode - no database</p>
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

  // Get blocker tasks (tasks that block this one)
  const blockedByIds = (task.blockedByTaskIds as string[] | null) ?? [];
  const blockerTasks = blockedByIds.length > 0
    ? await db.query.tasks.findMany({
        where: inArray(tasks.id, blockedByIds),
        columns: { id: true, title: true, status: true },
      })
    : [];

  // Get dependent tasks (tasks that this one blocks)
  const dependentRows = await db.execute(
    sql`SELECT id, title, status FROM tasks WHERE blocked_by_task_ids @> ${JSON.stringify([id])}::jsonb AND workspace_id = ${task.workspaceId}`
  );
  const dependentTasks = (dependentRows.rows ?? dependentRows) as Array<{ id: string; title: string; status: string }>;

  // Get workers for this task
  const taskWorkers = await db.query.workers.findMany({
    where: eq(workers.taskId, id),
    orderBy: desc(workers.createdAt),
    with: {
      account: true,
    },
  });

  // Fetch artifacts for all workers on this task
  const workerIds = taskWorkers.map(w => w.id);
  const taskArtifacts = workerIds.length > 0
    ? await db.query.artifacts.findMany({ where: inArray(artifacts.workerId, workerIds) })
    : [];
  const deliverableArtifacts = taskArtifacts.filter(
    a => a.type !== 'impl_plan'
  );

  // Get the active worker (if any)
  const activeWorker = taskWorkers.find(w =>
    ['running', 'starting', 'waiting_input', 'awaiting_plan_approval'].includes(w.status)
  );

  // Override task status for UI if worker is waiting or awaiting plan
  // Don't override if task is already in a terminal state (completed/failed)
  const isTerminal = task.status === 'completed' || task.status === 'failed';
  const displayStatus = !isTerminal && activeWorker?.status === 'waiting_input'
    ? 'waiting_input'
    : !isTerminal && activeWorker?.status === 'awaiting_plan_approval'
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

  // --- Helpers ---

  function timeAgo(date: Date | string): string {
    const now = Date.now();
    const then = new Date(date).getTime();
    const seconds = Math.floor((now - then) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  const TASK_ICONS: Record<string, { icon: string; bg: string; text: string }> = {
    completed:              { icon: '\u2713', bg: 'bg-status-success/12', text: 'text-status-success' },
    running:                { icon: '\u27F3', bg: 'bg-status-running/12', text: 'text-status-running' },
    assigned:               { icon: '\u27F3', bg: 'bg-status-info/12',    text: 'text-status-info' },
    starting:               { icon: '\u27F3', bg: 'bg-status-running/12', text: 'text-status-running' },
    pending:                { icon: '\u25CB', bg: 'bg-status-warning/12', text: 'text-status-warning' },
    failed:                 { icon: '\u2715', bg: 'bg-status-error/12',   text: 'text-status-error' },
    waiting_input:          { icon: '!',      bg: 'bg-status-warning/12', text: 'text-status-warning' },
    awaiting_plan_approval: { icon: '!',      bg: 'bg-status-warning/12', text: 'text-status-warning' },
    blocked:                { icon: '\u29B8', bg: 'bg-status-info/12',    text: 'text-status-info' },
  };
  const DEFAULT_ICON = TASK_ICONS.pending;

  return (
    <div className="p-4 md:p-8 overflow-auto h-full">
      <div className="max-w-4xl">
        {/* Auto-refresh when worker claims this task */}
        <TaskAutoRefresh taskId={task.id} workspaceId={task.workspaceId} taskStatus={task.status} />

        {/* Breadcrumbs — hidden on mobile (mobile header has nav) */}
        <nav aria-label="Breadcrumb" className="hidden md:block text-sm text-text-secondary mb-4">
          <Link href="/app/tasks" className="hover:text-text-primary">Tasks</Link>
          <span className="mx-2">/</span>
          <span className="text-text-primary">{task.title}</span>
        </nav>

        {/* Header */}
        <div className="flex flex-col md:flex-row md:justify-between md:items-start gap-3 mb-6">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2 flex-wrap">
              <h1 className="text-[28px] font-semibold tracking-tight break-words">{task.title}</h1>
              <span data-testid="task-header-status" data-status={displayStatus}>
                <StatusBadge status={displayStatus} />
              </span>
              {task.category && (
                <span className={`px-2 py-0.5 text-xs font-medium rounded ${CATEGORY_COLORS[task.category] || 'bg-cat-chore/15 text-cat-chore'}`}>
                  {task.category}
                </span>
              )}
              {task.project && (
                <span className="px-2 py-0.5 text-xs font-medium rounded bg-primary/10 text-primary">
                  {task.project}
                </span>
              )}
            </div>
            <p className="text-[14px] text-text-secondary">
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
                project: task.project,
                workspaceId: task.workspaceId,
              }}
            />
            {canReassign && <ReassignButton taskId={task.id} taskStatus={task.status} />}
            {task.externalUrl && (
              <a
                href={task.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-[18px] py-[9px] text-[13px] font-medium border border-border-default rounded-[6px] hover:bg-surface-3"
              >
                View Source
              </a>
            )}
            <DeleteTaskButton taskId={task.id} taskStatus={task.status} />
          </div>
        </div>

        <div className="flex flex-col">
        {/* Description */}
        {task.description && (
          <div className="mb-6">
            <div className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-4">
              Description
            </div>
            <div className="p-4 bg-surface-2 rounded-[10px]">
              <MarkdownContent content={task.description} />
            </div>
          </div>
        )}

        {/* Output Schema */}
        {(task.outputSchema as any) && (
          <div className="mb-6">
            <div className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-4">
              Output Schema
            </div>
            <pre className="p-4 bg-surface-2 rounded-[10px] overflow-x-auto text-sm font-mono text-text-primary">
              {JSON.stringify(task.outputSchema, null, 2)}
            </pre>
          </div>
        )}

        {/* Task Relationships */}
        {(task.parentTask || (task.subTasks && task.subTasks.length > 0) || blockerTasks.length > 0 || dependentTasks.length > 0) && (
          <div className="mb-6">
            <div className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-4">
              Related Tasks
            </div>
            <div className="p-4 bg-surface-2 rounded-[10px] space-y-3">
              {task.parentTask && (
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-text-muted uppercase tracking-[1px]">Parent:</span>
                  <Link
                    href={`/app/tasks/${task.parentTask.id}`}
                    className="text-sm text-primary-400 hover:underline"
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
                  <span className="font-mono text-[10px] text-text-muted uppercase tracking-[1px]">Subtasks ({task.subTasks.length}):</span>
                  <div className="mt-2 space-y-1 ml-4">
                    {task.subTasks.map((sub: { id: string; title: string; status: string }) => (
                      <div key={sub.id} className="flex items-center gap-2">
                        <Link
                          href={`/app/tasks/${sub.id}`}
                          className="text-sm text-primary-400 hover:underline"
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
              {blockerTasks.length > 0 && (
                <div>
                  <span className="font-mono text-[10px] text-text-muted uppercase tracking-[1px]">Blocked By ({blockerTasks.length}):</span>
                  <div className="mt-2 space-y-1 ml-4">
                    {blockerTasks.map((blocker) => (
                      <div key={blocker.id} className="flex items-center gap-2">
                        <Link href={`/app/tasks/${blocker.id}`} className="text-sm text-primary-400 hover:underline">
                          {blocker.title}
                        </Link>
                        <StatusBadge status={blocker.status} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {dependentTasks.length > 0 && (
                <div>
                  <span className="font-mono text-[10px] text-text-muted uppercase tracking-[1px]">Blocking ({dependentTasks.length}):</span>
                  <div className="mt-2 space-y-1 ml-4">
                    {dependentTasks.map((dep) => (
                      <div key={dep.id} className="flex items-center gap-2">
                        <Link href={`/app/tasks/${dep.id}`} className="text-sm text-primary-400 hover:underline">
                          {dep.title}
                        </Link>
                        <StatusBadge status={dep.status} />
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
            <div className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-4">
              Attachments
            </div>
            <div className="flex flex-wrap gap-2">
              {attachments.map((att, i) => (
                <div key={i} className="relative">
                  {att.mimeType.startsWith('image/') ? (
                    <img
                      src={att.src}
                      alt={att.filename}
                      className="max-h-32 rounded-[6px] border border-border-default"
                    />
                  ) : (
                    <div className="p-3 bg-surface-3 rounded-[6px]">
                      <span className="text-sm">{att.filename}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Stat Cards — compact inline on mobile */}
        <div className="md:hidden mb-6 px-1 flex items-center gap-1.5 text-[13px] text-text-secondary font-medium flex-wrap">
          <span>P{task.priority}</span>
          <span className="text-text-muted">&middot;</span>
          <span>{task.runnerPreference}</span>
          <span className="text-text-muted">&middot;</span>
          <span>claimed by {task.account?.name || '-'}</span>
          <span className="text-text-muted">&middot;</span>
          <span>{taskWorkers.length} worker{taskWorkers.length !== 1 ? 's' : ''}</span>
        </div>
        <div className="hidden md:grid md:grid-cols-4 gap-3 mb-8">
          <div className="bg-surface-2 border border-border-default rounded-[10px] p-4">
            <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted mb-1.5">Priority</div>
            <div className="text-2xl font-semibold">{task.priority}</div>
          </div>
          <div className="bg-surface-2 border border-border-default rounded-[10px] p-4">
            <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted mb-1.5">Runner</div>
            <div className="text-2xl font-semibold">{task.runnerPreference}</div>
          </div>
          <div className="bg-surface-2 border border-border-default rounded-[10px] p-4">
            <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted mb-1.5">Claimed By</div>
            <div className="text-2xl font-semibold truncate">{task.account?.name || '-'}</div>
          </div>
          <div className="bg-surface-2 border border-border-default rounded-[10px] p-4">
            <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted mb-1.5">Workers</div>
            <div className="text-2xl font-semibold">{taskWorkers.length}</div>
          </div>
        </div>

        {/* Active Worker */}
        {activeWorker && (
          <div className="mb-8 order-first md:order-none">
            <div className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-6 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full border-2 border-status-running border-t-transparent animate-spin" aria-hidden="true"></span>
              Active Worker
            </div>
            {/* Plan Review Panel — shown when awaiting approval or when a plan artifact exists */}
            {(displayStatus === 'awaiting_plan_approval' || taskArtifacts.some(a => a.type === 'task_plan' && a.workerId === activeWorker.id)) && (
              <PlanReviewPanel
                workerId={activeWorker.id}
                isAwaitingApproval={displayStatus === 'awaiting_plan_approval'}
                milestones={(activeWorker.milestones as any[]) || []}
                currentAction={activeWorker.currentAction}
              />
            )}
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
                resultMeta: activeWorker.resultMeta as any,
              }}
            />
          </div>
        )}

        </div>{/* end flex container */}

        {/* Deliverables */}
        {(task.result as any) && (
          (() => {
            const result = task.result as { summary?: string; branch?: string; commits?: number; sha?: string; files?: number; added?: number; removed?: number; prUrl?: string; prNumber?: number; structuredOutput?: Record<string, unknown> };
            const hasCodeDeliverables = (result.commits ?? 0) > 0 || !!result.prUrl || !!result.branch;

            return (
              <div className="mb-8">
                <div className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-4">
                  Deliverables
                </div>

                {/* Non-code summary — shown prominently when no code deliverables */}
                {!hasCodeDeliverables && result.summary && (
                  <div className="p-5 bg-surface-2 border border-border-default rounded-[10px] mb-4">
                    <MarkdownContent content={result.summary} />
                  </div>
                )}

                {/* Code deliverables bar */}
                {hasCodeDeliverables && (
                  <div className="p-4 bg-status-success/10 border border-status-success/20 rounded-[10px]">
                    <div className="flex items-center gap-3 text-sm flex-wrap">
                      {result.branch && (
                        <code className="px-2 py-0.5 bg-status-success/15 text-status-success rounded text-xs">
                          {result.branch}
                        </code>
                      )}
                      {(result.commits ?? 0) > 0 && (
                        <span className="text-text-secondary text-xs">
                          {result.commits} commit{result.commits !== 1 ? 's' : ''}
                        </span>
                      )}
                      {((result.added ?? 0) > 0 || (result.removed ?? 0) > 0) && (
                        <span className="text-xs">
                          <span className="text-status-success">+{result.added}</span>
                          <span className="text-status-error">/{'-'}{result.removed}</span>
                        </span>
                      )}
                      {(result.files ?? 0) > 0 && (
                        <span className="text-xs text-text-secondary">{result.files} files</span>
                      )}
                      {result.sha && (
                        <code className="font-mono text-xs text-text-muted">{result.sha.slice(0, 7)}</code>
                      )}
                      {result.prUrl && (
                        <a
                          href={result.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-[5px] text-xs bg-status-success/10 text-status-success rounded-[6px] hover:bg-status-success/20"
                        >
                          PR #{result.prNumber}
                        </a>
                      )}
                    </div>
                    {result.summary && (
                      <p className="text-sm text-text-secondary mt-2">{result.summary}</p>
                    )}
                  </div>
                )}

                {/* Structured Output */}
                {result.structuredOutput && (
                  <div className="mt-4">
                    <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted mb-2">
                      Structured Output
                    </div>
                    <pre className="p-4 bg-surface-2 border border-border-default rounded-[10px] overflow-x-auto text-sm font-mono text-text-primary">
                      {JSON.stringify(result.structuredOutput, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })()
        )}

        {/* Artifacts */}
        {deliverableArtifacts.length > 0 && (
          <div className="mb-8">
            <div className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-4">
              Artifacts ({deliverableArtifacts.length})
            </div>
            <div className="space-y-3">
              {deliverableArtifacts.map((art) => {
                const artMeta = art.metadata as Record<string, unknown> | null;
                const artUrl = artMeta?.url as string | undefined;
                const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';
                const shareLink = art.shareToken ? `${baseUrl}/share/${art.shareToken}` : null;

                return (
                  <div key={art.id} className="p-4 bg-surface-2 border border-border-default rounded-[10px]">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider bg-surface-3 text-text-muted rounded">
                        {art.type}
                      </span>
                      <span className="text-sm font-medium text-text-primary">{art.title}</span>
                      {shareLink && (
                        <a
                          href={shareLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-auto px-2.5 py-1 text-[11px] bg-surface-3 border border-border-default rounded hover:bg-surface-4 text-text-secondary"
                        >
                          Share
                        </a>
                      )}
                    </div>
                    {art.type === 'link' && artUrl && (
                      <a
                        href={artUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary-400 hover:underline break-all"
                      >
                        {artUrl}
                      </a>
                    )}
                    {(art.type === 'content' || art.type === 'report' || art.type === 'summary') && art.content && (
                      <p className="text-sm text-text-secondary line-clamp-3">
                        {art.content.length > 500 ? art.content.slice(0, 500) + '...' : art.content}
                      </p>
                    )}
                    {art.type === 'data' && art.content && (
                      <pre className="text-xs font-mono text-text-muted mt-1 line-clamp-3 overflow-hidden">
                        {art.content.length > 500 ? art.content.slice(0, 500) + '...' : art.content}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Worker History */}
        {taskWorkers.length > 0 && (
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-6">
              Worker History
            </div>
            <div className="border border-border-default rounded-[10px] overflow-hidden">
              {taskWorkers.map((worker) => {
                const iconStyle = TASK_ICONS[worker.status] || DEFAULT_ICON;
                return (
                  <div key={worker.id} className="flex items-center gap-4 px-3 py-3 md:px-4 md:py-3.5 border-b border-border-default/40 last:border-b-0 hover:bg-surface-3">
                    <div className={`w-7 h-7 rounded-[6px] flex items-center justify-center text-[13px] flex-shrink-0 ${iconStyle.bg} ${iconStyle.text}`}>
                      {iconStyle.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-text-primary truncate">{worker.name}</div>
                      <div className="font-mono text-[11px] text-text-muted truncate">
                        {worker.branch}
                        {worker.account && ` \u00B7 ${worker.account.name}`}
                      </div>
                      {worker.error && (
                        <p className="font-mono text-[11px] text-status-error mt-0.5 truncate">{worker.error}</p>
                      )}
                      <div className="flex items-center gap-3 mt-1 font-mono text-[11px] text-text-muted">
                        <span>{worker.startedAt ? timeAgo(worker.startedAt) : '-'}</span>
                        <span>{worker.turns} turns</span>
                        <span>${parseFloat(worker.costUsd?.toString() || '0').toFixed(4)}</span>
                        {(worker.resultMeta as any)?.stopReason && (worker.resultMeta as any).stopReason !== 'end_turn' && (
                          <span className="text-status-warning">stop: {(worker.resultMeta as any).stopReason}</span>
                        )}
                      </div>
                      {/* Per-model usage breakdown — hidden on mobile for density */}
                      {(worker.resultMeta as any)?.modelUsage && Object.keys((worker.resultMeta as any).modelUsage).length > 0 && (
                        <div className="hidden md:flex mt-1.5 flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-text-muted">
                          {Object.entries((worker.resultMeta as any).modelUsage as Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; costUSD: number }>).map(([model, usage]) => (
                            <span key={model} className="inline-flex items-center gap-1">
                              <span className="text-text-secondary">{model.replace('claude-', '').replace(/-\d{8}$/, '')}</span>
                              <span>{((usage.inputTokens + usage.cacheReadInputTokens) / 1000).toFixed(0)}k in</span>
                              <span>{(usage.outputTokens / 1000).toFixed(0)}k out</span>
                              {usage.costUSD > 0 && <span className="text-text-secondary">${usage.costUSD.toFixed(4)}</span>}
                            </span>
                          ))}
                          {(worker.resultMeta as any).durationMs > 0 && (
                            <span>{((worker.resultMeta as any).durationMs / 1000).toFixed(0)}s total</span>
                          )}
                          {(worker.resultMeta as any).durationApiMs > 0 && (
                            <span>{((worker.resultMeta as any).durationApiMs / 1000).toFixed(0)}s API</span>
                          )}
                        </div>
                      )}
                    </div>
                    <StatusBadge status={worker.status} />
                    <div className="flex items-center gap-2">
                      {worker.prUrl && (
                        <a
                          href={worker.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-[5px] text-xs bg-status-success/10 text-status-success rounded-[6px] hover:bg-status-success/20"
                        >
                          PR #{worker.prNumber}
                        </a>
                      )}
                      {worker.localUiUrl && (
                        <a
                          href={`${worker.localUiUrl}/worker/${worker.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`px-3 py-[5px] text-xs rounded-[6px] bg-surface-3 border border-border-default hover:bg-surface-4${/^https?:\/\/(localhost|127\.0\.0\.1)/.test(worker.localUiUrl) ? ' hidden sm:inline-block' : ''}`}
                        >
                          View
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Empty state */}
        {taskWorkers.length === 0 && task.status === 'pending' && (
          <div className="border border-dashed border-border-default rounded-[10px] p-8 text-center">
            <p className="text-text-secondary mb-2">This task is waiting to be started</p>
            <p className="text-sm text-text-muted mb-4">
              Click &quot;Start Task&quot; above to assign it to a worker, or wait for a worker to claim it automatically.
            </p>
            <StartTaskButton taskId={task.id} workspaceId={task.workspaceId} />
          </div>
        )}
      </div>
    </div>
  );
}
