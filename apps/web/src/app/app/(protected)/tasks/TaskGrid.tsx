'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';

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
}

const CATEGORY_COLORS: Record<string, string> = {
  bug: 'var(--cat-bug)',
  feature: 'var(--cat-feature)',
  refactor: 'var(--cat-refactor)',
  chore: 'var(--cat-chore)',
  docs: 'var(--cat-docs)',
  test: 'var(--cat-test)',
  infra: 'var(--cat-infra)',
  design: 'var(--cat-design)',
};

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

function groupByTime(tasks: GridTask[]): { label: string; tasks: GridTask[] }[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);

  const groups: { label: string; tasks: GridTask[] }[] = [
    { label: 'Needs input', tasks: [] },
    { label: 'Active', tasks: [] },
    { label: 'Today', tasks: [] },
    { label: 'Yesterday', tasks: [] },
    { label: 'This week', tasks: [] },
    { label: 'Older', tasks: [] },
  ];

  for (const t of tasks) {
    if (t.status === 'waiting_input') {
      groups[0].tasks.push(t);
      continue;
    }
    const isActive = ['in_progress', 'assigned', 'pending'].includes(t.status);
    if (isActive) {
      groups[1].tasks.push(t);
      continue;
    }
    const d = new Date(t.updatedAt);
    if (d >= today) groups[2].tasks.push(t);
    else if (d >= yesterday) groups[3].tasks.push(t);
    else if (d >= weekAgo) groups[4].tasks.push(t);
    else groups[5].tasks.push(t);
  }

  return groups.filter(g => g.tasks.length > 0);
}

function TaskTile({ task }: { task: GridTask }) {
  const catColor = task.category ? CATEGORY_COLORS[task.category] : undefined;
  const hasPR = !!task.prUrl;
  const [showTooltip, setShowTooltip] = useState(false);
  const isWaiting = task.status === 'waiting_input';
  const isRunning = task.status === 'in_progress' || task.status === 'assigned';

  // Outcome ring: amber+pulse = needs input, green = PR, amber = artifact
  const outcomeRing = isWaiting
    ? 'ring-1 ring-status-warning/50'
    : hasPR
      ? 'ring-1 ring-status-success/40'
      : task.hasArtifact
        ? 'ring-1 ring-status-warning/40'
        : '';

  return (
    <div className="relative group">
      <Link
        href={`/app/tasks/${task.id}`}
        className={`
          block relative w-full rounded-lg bg-surface-2 border border-border-default
          hover:bg-surface-3 hover:border-text-muted/30 transition-all
          ${outcomeRing}
          ${isRunning ? 'border-status-running/40' : ''}
          ${isWaiting ? 'border-status-warning/30' : ''}
          ${isWaiting ? 'h-[88px]' : 'h-[72px]'}
        `}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        {/* Category accent — top stripe */}
        {catColor && !isWaiting && (
          <div
            className="absolute top-0 left-2 right-2 h-[2px] rounded-b"
            style={{ backgroundColor: catColor, opacity: 0.6 }}
          />
        )}

        {/* Waiting: full amber top stripe overrides category */}
        {isWaiting && (
          <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-lg bg-status-warning/70" />
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

          {/* Bottom row: outcome badges */}
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
                <svg className="w-2.5 h-2.5" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                </svg>
                PR{task.prNumber ? ` #${task.prNumber}` : ''}
              </a>
            )}
            {!isWaiting && task.hasArtifact && !hasPR && (
              <span className="inline-flex items-center gap-0.5 px-1 py-0.5 text-[9px] font-mono rounded bg-status-warning/10 text-status-warning">
                artifact
              </span>
            )}
            <span className="ml-auto text-[9px] font-mono text-text-muted">
              {timeAgo(task.updatedAt)}
            </span>
          </div>
        </div>
      </Link>

      {/* Tooltip on hover */}
      {showTooltip && (task.summary || task.waitingPrompt) && (
        <div className="absolute z-50 bottom-full left-0 mb-2 w-64 p-3 rounded-lg bg-surface-3 border border-border-default shadow-lg pointer-events-none">
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
            {task.category && (
              <span
                className="text-[9px] font-mono px-1 rounded"
                style={{ color: CATEGORY_COLORS[task.category], backgroundColor: `${CATEGORY_COLORS[task.category]}15` }}
              >
                {task.category}
              </span>
            )}
            {task.filesChanged && (
              <span className="text-[9px] font-mono text-text-muted">{task.filesChanged} files</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type FilterStatus = 'all' | 'needs_input' | 'active' | 'completed' | 'failed';

export default function TaskGrid({ tasks }: { tasks: GridTask[] }) {
  const [filter, setFilter] = useState<FilterStatus>('all');

  const filtered = useMemo(() => {
    if (filter === 'all') return tasks;
    if (filter === 'needs_input') return tasks.filter(t => t.status === 'waiting_input');
    if (filter === 'active') return tasks.filter(t => ['in_progress', 'assigned', 'waiting_input', 'pending'].includes(t.status));
    if (filter === 'completed') return tasks.filter(t => t.status === 'completed');
    if (filter === 'failed') return tasks.filter(t => t.status === 'failed');
    return tasks;
  }, [tasks, filter]);

  const groups = useMemo(() => groupByTime(filtered), [filtered]);

  // Stats
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
      <div className="max-w-5xl mx-auto p-6">
        {/* Header stats */}
        <div className="flex items-center gap-6 mb-6">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-text-muted">Last 30 days</div>
            <div className="text-2xl font-semibold text-text-primary mt-0.5">{tasks.length} <span className="text-sm font-normal text-text-secondary">tasks</span></div>
          </div>
          <div className="flex gap-4 ml-auto text-center">
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

        {/* Filters */}
        <div className="flex gap-1.5 mb-5">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors flex items-center gap-1.5 ${
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

        {/* Task grid by time group */}
        <div className="space-y-6">
          {groups.map((group) => (
            <div key={group.label}>
              <div className={`text-[10px] font-mono uppercase tracking-[2.5px] mb-3 pb-1.5 border-b ${
                group.label === 'Needs input'
                  ? 'text-status-warning border-status-warning/20'
                  : 'text-text-muted border-border-default'
              }`}>
                {group.label}
                <span className="ml-2 normal-case tracking-normal">{group.tasks.length}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                {group.tasks.map((task) => (
                  <TaskTile key={task.id} task={task} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
