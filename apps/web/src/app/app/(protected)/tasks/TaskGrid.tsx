'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface GridTask {
  id: string;
  title: string;
  status: string;
  category: string | null;
  updatedAt: string;
  workspaceName: string;
  prUrl: string | null;
  prNumber: number | null;
  summary: string | null;
  hasArtifact: boolean;
  filesChanged: number | null;
  waitingPrompt: string | null;
  objectiveId: string | null;
  objectiveTitle: string | null;
}

interface CollapsedGroup {
  type: 'collapsed';
  objectiveId: string;
  objectiveTitle: string;
  tasks: GridTask[];
  latestTask: GridTask;
  count: number;
}

interface SingleTask {
  type: 'single';
  task: GridTask;
}

type SwimLaneItem = CollapsedGroup | SingleTask;

interface WorkspaceRow {
  workspaceName: string;
  items: SwimLaneItem[];
  hasActive: boolean;
  latestUpdate: string;
}

function getStatusDotClass(status: string): string {
  switch (status) {
    case 'completed': return 'bg-status-success';
    case 'in_progress':
    case 'assigned': return 'bg-status-running';
    case 'pending': return 'bg-text-muted';
    case 'failed': return 'bg-status-error';
    case 'waiting_input': return 'bg-status-warning';
    default: return 'bg-text-muted';
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const STATUS_PRIORITY: Record<string, number> = {
  waiting_input: 0,
  in_progress: 1,
  assigned: 2,
  pending: 3,
  failed: 4,
  completed: 5,
};

function isActive(status: string): boolean {
  return ['in_progress', 'assigned', 'pending', 'waiting_input'].includes(status);
}

function buildWorkspaceRows(tasks: GridTask[]): { needsInput: GridTask[]; workspaceRows: WorkspaceRow[] } {
  // Extract needs-input tasks (cross-workspace pinned section)
  const needsInput = tasks.filter(t => t.status === 'waiting_input');
  const nonWaiting = tasks.filter(t => t.status !== 'waiting_input');

  // Group by workspace
  const byWorkspace = new Map<string, GridTask[]>();
  for (const t of nonWaiting) {
    const existing = byWorkspace.get(t.workspaceName) || [];
    existing.push(t);
    byWorkspace.set(t.workspaceName, existing);
  }

  const workspaceRows: WorkspaceRow[] = [];

  for (const [workspaceName, wsTasks] of byWorkspace) {
    // Sort: active first (by status priority), then by recency
    const sorted = [...wsTasks].sort((a, b) => {
      const aPri = STATUS_PRIORITY[a.status] ?? 99;
      const bPri = STATUS_PRIORITY[b.status] ?? 99;
      if (aPri !== bPri) return aPri - bPri;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    // Collapse recurring: completed tasks sharing objectiveId with 3+ instances
    const completedByObjective = new Map<string, GridTask[]>();
    const items: SwimLaneItem[] = [];
    const deferredObjectiveIds = new Set<string>();

    // First pass: identify collapsible objectives
    for (const t of sorted) {
      if (t.status === 'completed' && t.objectiveId) {
        const group = completedByObjective.get(t.objectiveId) || [];
        group.push(t);
        completedByObjective.set(t.objectiveId, group);
      }
    }
    for (const [objId, group] of completedByObjective) {
      if (group.length >= 3) {
        deferredObjectiveIds.add(objId);
      }
    }

    // Second pass: build items
    const addedObjectives = new Set<string>();
    for (const t of sorted) {
      if (t.status === 'completed' && t.objectiveId && deferredObjectiveIds.has(t.objectiveId)) {
        if (!addedObjectives.has(t.objectiveId)) {
          addedObjectives.add(t.objectiveId);
          const group = completedByObjective.get(t.objectiveId)!;
          items.push({
            type: 'collapsed',
            objectiveId: t.objectiveId,
            objectiveTitle: t.objectiveTitle || t.title,
            tasks: group,
            latestTask: group[0], // already sorted by recency
            count: group.length,
          });
        }
        // Skip individual tasks that are collapsed
        continue;
      }
      items.push({ type: 'single', task: t });
    }

    const hasActiveTask = wsTasks.some(t => isActive(t.status));
    const latestUpdate = sorted[0]?.updatedAt || '';

    workspaceRows.push({
      workspaceName,
      items,
      hasActive: hasActiveTask,
      latestUpdate,
    });
  }

  // Sort workspace rows: active workspaces first, then by most recent task
  workspaceRows.sort((a, b) => {
    if (a.hasActive !== b.hasActive) return a.hasActive ? -1 : 1;
    return new Date(b.latestUpdate).getTime() - new Date(a.latestUpdate).getTime();
  });

  return { needsInput, workspaceRows };
}

/** PR icon — git merge/PR symbol */
function PrIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor">
      <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
    </svg>
  );
}

/** Document icon — for artifacts */
function DocIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  );
}

/** Artifact viewer modal — full screen formatted markdown */
function ArtifactViewer({ taskId, title, onClose }: { taskId: string; title: string; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/tasks/${taskId}/artifacts`)
      .then(res => res.json())
      .then(data => {
        // Find first content/report/summary artifact
        const artifacts = data.artifacts || [];
        const textArtifact = artifacts.find((a: { type: string }) =>
          ['content', 'report', 'summary'].includes(a.type)
        );
        setContent(textArtifact?.content || null);
      })
      .catch(() => setContent(null))
      .finally(() => setLoading(false));
  }, [taskId]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface-2 rounded-xl border border-border-default shadow-2xl w-full max-w-2xl max-h-[85vh] mx-4 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-default shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <DocIcon className="w-4 h-4 text-primary shrink-0" />
            <span className="text-sm font-semibold text-text-primary truncate">{title}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-3 rounded-lg"
            aria-label="Close"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <span className="w-5 h-5 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
            </div>
          ) : content ? (
            <div className="prose prose-sm prose-invert max-w-none text-text-primary
              prose-headings:text-text-primary prose-p:text-text-secondary
              prose-a:text-primary prose-strong:text-text-primary
              prose-code:text-primary prose-code:bg-surface-3 prose-code:px-1 prose-code:py-0.5 prose-code:rounded
              prose-pre:bg-surface-3 prose-pre:border prose-pre:border-border-default
              prose-li:text-text-secondary
              whitespace-pre-wrap leading-relaxed text-sm"
            >
              {content}
            </div>
          ) : (
            <div className="text-center py-12">
              <p className="text-text-muted text-sm">No artifact content available.</p>
              <Link
                href={`/app/tasks/${taskId}`}
                className="text-primary text-sm hover:underline mt-2 inline-block"
                onClick={onClose}
              >
                View task details
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TaskTile({ task, onViewArtifact }: { task: GridTask; onViewArtifact?: (taskId: string, title: string) => void }) {
  const hasPR = !!task.prUrl;
  const [showTooltip, setShowTooltip] = useState(false);
  const isWaiting = task.status === 'waiting_input';
  const isRunning = task.status === 'in_progress' || task.status === 'assigned';

  // Outcome ring: amber+pulse = needs input, green = PR, primary = artifact
  const outcomeRing = isWaiting
    ? 'ring-1 ring-status-warning/50'
    : hasPR
      ? 'ring-1 ring-status-success/40'
      : task.hasArtifact
        ? 'ring-1 ring-primary/30'
        : '';

  return (
    <div className="relative group shrink-0 w-[calc(50%-4px)] md:w-[180px]">
      <Link
        href={`/app/tasks/${task.id}`}
        className={`
          block relative w-full rounded-xl bg-surface-2 border border-border-default
          hover:bg-surface-3 hover:border-text-muted/30 transition-all duration-150
          shadow-[0_1px_3px_rgba(0,0,0,0.07),0_1px_2px_rgba(0,0,0,0.04)]
          hover:shadow-[0_4px_10px_rgba(0,0,0,0.1),0_2px_5px_rgba(0,0,0,0.06)]
          hover:-translate-y-px
          ${outcomeRing}
          ${isRunning ? 'border-status-running/40' : ''}
          ${isWaiting ? 'border-status-warning/30' : ''}
          ${isWaiting ? 'h-[88px]' : 'h-[72px]'}
        `}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        {/* Running: animated top stripe */}
        {isRunning && (
          <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl bg-status-running/70" />
        )}

        {/* Waiting: full amber top stripe */}
        {isWaiting && (
          <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl bg-status-warning/70" />
        )}

        {/* Content */}
        <div className={`p-2.5 pt-3 h-full flex flex-col justify-between`}>
          {/* Title row */}
          <div className="flex items-start gap-1.5 min-w-0">
            <span className={`mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 ${getStatusDotClass(task.status)} ${isRunning ? 'animate-pulse' : ''} ${isWaiting ? 'animate-pulse' : ''}`} />
            <span className="text-[12px] font-medium text-text-primary leading-tight line-clamp-2 min-w-0">
              {task.title}
            </span>
          </div>

          {/* Waiting prompt preview */}
          {isWaiting && task.waitingPrompt && (
            <div className="text-[10px] text-status-warning/80 leading-snug line-clamp-1 mt-1 ml-3">
              {task.waitingPrompt}
            </div>
          )}

          {/* Bottom row: output type badges + timestamp */}
          <div className="flex items-center gap-1.5 mt-auto">
            {isWaiting && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-mono rounded bg-status-warning/10 text-status-warning">
                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
                needs input
              </span>
            )}
            {!isWaiting && hasPR && (
              <a
                href={task.prUrl!}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-0.5 px-1 py-0.5 text-[9px] font-mono rounded bg-status-success/10 text-status-success hover:bg-status-success/20 transition-colors"
              >
                <PrIcon className="w-2.5 h-2.5" />
                PR{task.prNumber ? ` #${task.prNumber}` : ''}
              </a>
            )}
            {!isWaiting && task.hasArtifact && !hasPR && (
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onViewArtifact?.(task.id, task.title);
                }}
                className="inline-flex items-center gap-0.5 px-1 py-0.5 text-[9px] font-mono rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                <DocIcon className="w-2.5 h-2.5" />
                artifact
              </button>
            )}
            <span className="ml-auto text-[9px] font-mono text-text-muted">
              {timeAgo(task.updatedAt)}
            </span>
          </div>
        </div>
      </Link>

      {/* Tooltip on hover */}
      {showTooltip && (task.summary || task.waitingPrompt) && (
        <div className="hidden md:block absolute z-50 bottom-full left-0 mb-2 w-64 p-3 rounded-lg bg-surface-3 border border-border-default shadow-lg pointer-events-none">
          {/* Show waiting prompt in full on hover */}
          {isWaiting && task.waitingPrompt && (
            <div className="text-[11px] text-status-warning leading-relaxed mb-2">
              {task.waitingPrompt}
            </div>
          )}
          {task.summary && (
            <div className={`text-[11px] text-text-secondary leading-relaxed line-clamp-4 ${isWaiting && task.waitingPrompt ? 'pt-2 border-t border-border-default' : ''}`}>
              {task.summary}
            </div>
          )}
          <div className="flex items-center gap-2 mt-2 pt-2 border-t border-border-default">
            <span className="text-[9px] font-mono text-text-muted">{task.workspaceName}</span>
            {task.filesChanged && (
              <span className="text-[9px] font-mono text-text-muted">{task.filesChanged} files</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CollapsedTile({ group }: { group: CollapsedGroup }) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <div className="relative group shrink-0 w-[calc(50%-4px)] md:w-[180px]">
      <Link
        href={`/app/objectives/${group.objectiveId}`}
        className="block relative w-full rounded-lg h-[72px] transition-all hover:border-text-muted/30"
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        {/* Stacked card effect — two shadow layers behind */}
        <div className="absolute inset-0 translate-x-[3px] translate-y-[3px] rounded-lg bg-surface-3/50 border border-border-default/30" />
        <div className="absolute inset-0 translate-x-[1.5px] translate-y-[1.5px] rounded-lg bg-surface-3/70 border border-border-default/50" />

        {/* Main card */}
        <div className="relative w-full h-full rounded-lg bg-surface-3 border border-border-default hover:bg-surface-2 transition-colors">
          <div className="p-2.5 pt-3 h-full flex flex-col justify-between">
            {/* Title row */}
            <div className="flex items-start gap-1.5 min-w-0">
              <span className="mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 bg-status-success" />
              <span className="text-[12px] font-medium text-text-primary leading-tight line-clamp-2 min-w-0">
                {group.objectiveTitle}
              </span>
            </div>

            {/* Bottom row: count + recency */}
            <div className="flex items-center gap-1.5 mt-auto">
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-mono rounded bg-text-muted/10 text-text-secondary">
                &times;{group.count}
              </span>
              <span className="ml-auto text-[9px] font-mono text-text-muted">
                last: {timeAgo(group.latestTask.updatedAt)}
              </span>
            </div>
          </div>
        </div>
      </Link>

      {/* Tooltip on hover */}
      {showTooltip && (
        <div className="hidden md:block absolute z-50 bottom-full left-0 mb-2 w-64 p-3 rounded-lg bg-surface-3 border border-border-default shadow-lg pointer-events-none">
          <div className="text-[11px] text-text-primary font-medium mb-1">
            {group.objectiveTitle}
          </div>
          <div className="text-[10px] text-text-secondary leading-relaxed">
            {group.count} completed runs &middot; most recent {timeAgo(group.latestTask.updatedAt)}
          </div>
          <div className="flex items-center gap-2 mt-2 pt-2 border-t border-border-default">
            <span className="text-[9px] font-mono text-text-muted">{group.latestTask.workspaceName}</span>
            <span className="text-[9px] font-mono text-primary/70 ml-auto">view objective →</span>
          </div>
        </div>
      )}
    </div>
  );
}

type FilterStatus = 'all' | 'needs_input' | 'active' | 'completed' | 'failed';

export default function TaskGrid({ tasks }: { tasks: GridTask[] }) {
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [artifactViewer, setArtifactViewer] = useState<{ taskId: string; title: string } | null>(null);
  const router = useRouter();

  const handleViewArtifact = useCallback((taskId: string, title: string) => {
    setArtifactViewer({ taskId, title });
  }, []);

  const filtered = useMemo(() => {
    if (filter === 'all') return tasks;
    if (filter === 'needs_input') return tasks.filter(t => t.status === 'waiting_input');
    if (filter === 'active') return tasks.filter(t => ['in_progress', 'assigned', 'waiting_input', 'pending'].includes(t.status));
    if (filter === 'completed') return tasks.filter(t => t.status === 'completed');
    if (filter === 'failed') return tasks.filter(t => t.status === 'failed');
    return tasks;
  }, [tasks, filter]);

  const { needsInput, workspaceRows } = useMemo(() => buildWorkspaceRows(filtered), [filtered]);

  // Stats (always from unfiltered)
  const waitingCount = tasks.filter(t => t.status === 'waiting_input').length;
  const activeCount = tasks.filter(t => ['in_progress', 'assigned', 'waiting_input'].includes(t.status)).length;
  const completedCount = tasks.filter(t => t.status === 'completed').length;
  const prCount = tasks.filter(t => !!t.prUrl).length;

  if (tasks.length === 0) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="w-16 h-16 mx-auto bg-surface-3 rounded-full flex items-center justify-center mb-4">
            <svg className="w-8 h-8 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-text-primary mb-2">No tasks yet</h2>
          <p className="text-text-secondary mb-4">Create your first task to get started.</p>
          <Link
            href="/app/tasks/new"
            className="inline-flex items-center px-4 py-2 bg-primary text-white rounded-md hover:bg-primary-hover"
          >
            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Task
          </Link>
        </div>
      </div>
    );
  }

  const filters: { key: FilterStatus; label: string; count?: number; color?: string }[] = [
    { key: 'all', label: 'All' },
    ...(waitingCount > 0 ? [{ key: 'needs_input' as FilterStatus, label: 'Needs input', count: waitingCount, color: 'text-status-warning' }] : []),
    { key: 'active', label: 'Active' },
    { key: 'completed', label: 'Completed' },
    { key: 'failed', label: 'Failed' },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1400px] mx-auto p-3 md:p-6">
        {/* Header stats */}
        <div className="flex items-center gap-4 md:gap-6 mb-4 md:mb-6">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-text-muted">Last 30 days</div>
            <div className="text-xl md:text-2xl font-semibold text-text-primary mt-0.5">{tasks.length} <span className="text-sm font-normal text-text-secondary">tasks</span></div>
          </div>
          <div className="flex gap-3 md:gap-4 ml-auto text-center">
            {waitingCount > 0 && (
              <button onClick={() => setFilter('needs_input')} className="text-center hover:opacity-80 transition-opacity">
                <div className="text-lg font-semibold text-status-warning">{waitingCount}</div>
                <div className="text-[9px] font-mono text-text-muted uppercase tracking-wider">waiting</div>
              </button>
            )}
            {activeCount > 0 && (
              <div>
                <div className="text-lg font-semibold text-status-running">{activeCount}</div>
                <div className="text-[9px] font-mono text-text-muted uppercase tracking-wider">active</div>
              </div>
            )}
            <div>
              <div className="text-lg font-semibold text-status-success">{completedCount}</div>
              <div className="text-[9px] font-mono text-text-muted uppercase tracking-wider">done</div>
            </div>
            <div>
              <div className="text-lg font-semibold text-text-secondary">{prCount}</div>
              <div className="text-[9px] font-mono text-text-muted uppercase tracking-wider">PRs</div>
            </div>
          </div>
        </div>

        {/* Filters — horizontally scrollable on mobile */}
        <div className="flex gap-1.5 mb-4 md:mb-5 overflow-x-auto pb-1 -mx-3 px-3 md:mx-0 md:px-0">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors flex items-center gap-1.5 shrink-0 ${
                filter === f.key
                  ? f.key === 'needs_input' ? 'bg-status-warning/15 text-status-warning' : 'bg-primary/15 text-primary'
                  : 'text-text-muted hover:text-text-secondary hover:bg-surface-3'
              }`}
            >
              {f.label}
              {f.count !== undefined && (
                <span className={`text-[9px] font-mono ${f.color || ''}`}>{f.count}</span>
              )}
            </button>
          ))}
        </div>

        {/* Needs input — pinned section above workspace rows */}
        {needsInput.length > 0 && (
          <div className="mb-5 md:mb-6">
            <div className="text-[10px] font-mono uppercase tracking-[2.5px] mb-3 pb-1.5 border-b text-status-warning border-status-warning/20">
              Needs input
              <span className="ml-2 normal-case tracking-normal">{needsInput.length}</span>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-2 flex-wrap md:flex-nowrap">
              {needsInput.map((task) => (
                <TaskTile key={task.id} task={task} onViewArtifact={handleViewArtifact} />
              ))}
            </div>
          </div>
        )}

        {/* Workspace swim lanes */}
        <div className="space-y-5">
          {workspaceRows.map((row) => (
            <div key={row.workspaceName} className="group/row">
              {/* Mobile: workspace header as a row above tiles */}
              <div className="md:hidden flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">
                    {row.workspaceName}
                  </span>
                  {row.hasActive && (
                    <span className="flex items-center gap-1">
                      <span className="glow-dot glow-dot-running" />
                    </span>
                  )}
                  <span className="text-[9px] font-mono text-text-muted">
                    {row.items.length}
                  </span>
                </div>
              </div>

              <div className="flex items-start gap-4">
                {/* Desktop: Workspace label */}
                <div className="hidden md:block shrink-0 w-[100px] pt-5">
                  <div className="text-[10px] font-mono uppercase tracking-[2.5px] text-text-muted leading-tight">
                    {row.workspaceName}
                  </div>
                  <div className="text-[9px] font-mono text-text-muted/50 mt-0.5">
                    {row.items.length} {row.items.length === 1 ? 'item' : 'items'}
                  </div>
                </div>

                {/* Tiles — wrap on mobile, horizontal scroll on desktop */}
                <div className="flex-1 min-w-0">
                  <div className="flex gap-2 flex-wrap md:flex-nowrap md:overflow-x-auto pb-2 pt-1">
                    {row.items.map((item) =>
                      item.type === 'collapsed' ? (
                        <CollapsedTile key={`obj-${item.objectiveId}`} group={item} />
                      ) : (
                        <TaskTile key={item.task.id} task={item.task} onViewArtifact={handleViewArtifact} />
                      )
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Empty filtered state */}
        {workspaceRows.length === 0 && needsInput.length === 0 && filtered.length === 0 && tasks.length > 0 && (
          <div className="text-center py-12">
            <p className="text-text-muted text-sm">No tasks match this filter.</p>
          </div>
        )}
      </div>

      {/* Artifact viewer modal */}
      {artifactViewer && (
        <ArtifactViewer
          taskId={artifactViewer.taskId}
          title={artifactViewer.title}
          onClose={() => setArtifactViewer(null)}
        />
      )}
    </div>
  );
}
