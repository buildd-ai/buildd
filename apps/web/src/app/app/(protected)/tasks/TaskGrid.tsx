'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { Select } from '@/components/ui/Select';

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
  missionId: string | null;
  missionTitle: string | null;
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

type FilterStatus = 'all' | 'active' | 'completed' | 'failed';
type GroupBy = 'mission' | 'none' | 'status';

function getStatusDot(status: string): { color: string; pulse: boolean } {
  switch (status) {
    case 'completed': return { color: 'bg-status-success', pulse: false };
    case 'in_progress':
    case 'assigned': return { color: 'bg-status-info', pulse: true };
    case 'failed': return { color: 'bg-status-error', pulse: false };
    case 'waiting_input': return { color: 'bg-status-warning', pulse: false };
    case 'pending': return { color: 'bg-text-muted', pulse: false };
    default: return { color: 'bg-text-muted', pulse: false };
  }
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 text-[11px] font-medium rounded bg-status-error/15 text-status-error">
        Failed
      </span>
    );
  }
  if (status === 'in_progress' || status === 'assigned') {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 text-[11px] font-medium rounded bg-status-info/15 text-status-info">
        Running
      </span>
    );
  }
  return null;
}

function TaskRow({ task }: { task: GridTask }) {
  const dot = getStatusDot(task.status);
  const isCompleted = task.status === 'completed';

  return (
    <Link
      href={`/app/tasks/${task.id}`}
      className="flex items-center gap-3 px-4 py-2.5 border-b border-border-default hover:bg-surface-2/50 transition-colors"
    >
      {/* Status dot */}
      <span className={`w-2 h-2 rounded-full shrink-0 ${dot.color} ${dot.pulse ? 'animate-pulse' : ''}`} />

      {/* Title */}
      <span className={`text-[14px] truncate min-w-0 flex-1 ${isCompleted ? 'text-text-muted' : 'text-text-primary'}`}>
        {task.title}
      </span>

      {/* Status badge */}
      <StatusBadge status={task.status} />

      {/* PR link */}
      {task.prUrl && (
        <a
          href={task.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-[12px] text-accent-text hover:underline shrink-0"
        >
          #{task.prNumber}
        </a>
      )}

      {/* Workspace badge */}
      <span className="inline-flex items-center px-1.5 py-0.5 text-[11px] font-mono rounded-md bg-surface-3 text-text-secondary shrink-0">
        {task.workspaceName}
      </span>

      {/* Mission name (when not grouped by mission) */}
      {task.missionTitle && (
        <span className="text-[12px] text-text-muted truncate max-w-[160px] shrink-0 hidden sm:inline">
          {task.missionTitle}
        </span>
      )}

      {/* Time ago */}
      <span className="text-[12px] text-text-desc shrink-0 w-[70px] text-right">
        {timeAgo(task.updatedAt)}
      </span>
    </Link>
  );
}

interface MissionGroup {
  id: string | null;
  title: string;
  tasks: GridTask[];
  missionType: string | null;
}

interface StatusGroup {
  label: string;
  tasks: GridTask[];
}

interface TaskGridProps {
  tasks: GridTask[];
  missionFilter?: string | null;
  missionTitle?: string | null;
}

export default function TaskGrid({ tasks, missionFilter, missionTitle }: TaskGridProps) {
  // When viewing a single mission's tasks, filter to just those
  const visibleTasks = useMemo(() => {
    if (!missionFilter) return tasks;
    return tasks.filter(t => t.missionId === missionFilter);
  }, [tasks, missionFilter]);

  const [filter, setFilter] = useState<FilterStatus>('all');
  const [groupBy, setGroupBy] = useState<GroupBy>(missionFilter ? 'none' : 'mission');
  const [search, setSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Counts from unfiltered tasks
  const allCount = visibleTasks.length;
  const activeCount = visibleTasks.filter(t => ['in_progress', 'assigned', 'waiting_input', 'pending'].includes(t.status)).length;
  const completedCount = visibleTasks.filter(t => t.status === 'completed').length;
  const failedCount = visibleTasks.filter(t => t.status === 'failed').length;

  // Apply filter + search
  const filtered = useMemo(() => {
    let result = visibleTasks;
    if (filter === 'active') result = result.filter(t => ['in_progress', 'assigned', 'waiting_input', 'pending'].includes(t.status));
    else if (filter === 'completed') result = result.filter(t => t.status === 'completed');
    else if (filter === 'failed') result = result.filter(t => t.status === 'failed');

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(t => t.title.toLowerCase().includes(q));
    }

    return result;
  }, [visibleTasks, filter, search]);

  // Split out needs-input tasks (always pinned at top)
  const needsInputTasks = useMemo(() => filtered.filter(t => t.status === 'waiting_input'), [filtered]);
  const nonWaitingTasks = useMemo(() => filtered.filter(t => t.status !== 'waiting_input'), [filtered]);

  // Sort helper
  const sortTasks = (list: GridTask[]) =>
    [...list].sort((a, b) => {
      const aPri = STATUS_PRIORITY[a.status] ?? 99;
      const bPri = STATUS_PRIORITY[b.status] ?? 99;
      if (aPri !== bPri) return aPri - bPri;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

  // Build groups
  const missionGroups = useMemo((): MissionGroup[] => {
    if (groupBy !== 'mission') return [];
    const map = new Map<string | null, GridTask[]>();
    for (const t of nonWaitingTasks) {
      const key = t.missionId;
      const existing = map.get(key) || [];
      existing.push(t);
      map.set(key, existing);
    }
    const groups: MissionGroup[] = [];
    for (const [id, groupTasks] of map) {
      groups.push({
        id,
        title: id ? (groupTasks[0].missionTitle || 'Untitled mission') : 'No mission',
        tasks: sortTasks(groupTasks),
        missionType: null,
      });
    }
    // Sort: groups with active tasks first, then by recency
    groups.sort((a, b) => {
      const aHasActive = a.tasks.some(t => ['in_progress', 'assigned', 'pending'].includes(t.status));
      const bHasActive = b.tasks.some(t => ['in_progress', 'assigned', 'pending'].includes(t.status));
      if (aHasActive !== bHasActive) return aHasActive ? -1 : 1;
      // "No mission" at the bottom
      if (a.id === null && b.id !== null) return 1;
      if (a.id !== null && b.id === null) return -1;
      const aLatest = Math.max(...a.tasks.map(t => new Date(t.updatedAt).getTime()));
      const bLatest = Math.max(...b.tasks.map(t => new Date(t.updatedAt).getTime()));
      return bLatest - aLatest;
    });
    return groups;
  }, [nonWaitingTasks, groupBy]);

  const statusGroups = useMemo((): StatusGroup[] => {
    if (groupBy !== 'status') return [];
    const order: { key: string; label: string }[] = [
      { key: 'in_progress', label: 'Running' },
      { key: 'assigned', label: 'Assigned' },
      { key: 'pending', label: 'Pending' },
      { key: 'completed', label: 'Completed' },
      { key: 'failed', label: 'Failed' },
    ];
    const groups: StatusGroup[] = [];
    for (const { key, label } of order) {
      const matching = nonWaitingTasks.filter(t => t.status === key);
      if (matching.length > 0) {
        groups.push({
          label,
          tasks: [...matching].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
        });
      }
    }
    return groups;
  }, [nonWaitingTasks, groupBy]);

  const flatSorted = useMemo(() => {
    if (groupBy !== 'none') return [];
    return sortTasks(nonWaitingTasks);
  }, [nonWaitingTasks, groupBy]);

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  // Empty state
  if (visibleTasks.length === 0 && !missionFilter) {
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

  const filters: { key: FilterStatus; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: allCount },
    { key: 'active', label: 'Active', count: activeCount },
    { key: 'completed', label: 'Completed', count: completedCount },
    { key: 'failed', label: 'Failed', count: failedCount },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1000px] mx-auto py-4">
        {/* Breadcrumbs */}
        {missionFilter && (
          <div className="flex items-center gap-2 px-4 mb-3 text-[12px] text-text-muted">
            <Link href="/app/missions" className="hover:text-text-secondary transition-colors">
              Missions
            </Link>
            <span>/</span>
            <Link href={`/app/missions/${missionFilter}`} className="hover:text-text-secondary transition-colors truncate max-w-[200px]">
              {missionTitle || 'Mission'}
            </Link>
            <span>/</span>
            <span className="text-text-secondary">Tasks</span>
            <span className="mx-1 text-text-muted">&middot;</span>
            <Link href="/app/tasks" className="text-accent-text hover:underline">
              View all tasks
            </Link>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-4 mb-4">
          <h1 className="text-[28px] font-bold text-text-primary" style={{ fontFamily: 'var(--font-display, inherit)' }}>
            {missionFilter ? (missionTitle || 'Mission Tasks') : 'Tasks'}
          </h1>
          <Link
            href="/app/tasks/new"
            className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-primary text-white text-[14px] font-medium hover:bg-primary-hover transition-colors"
          >
            <span className="text-[14px] font-semibold">+</span>
            New Task
          </Link>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-2 px-4 mb-4">
          {/* Status tabs */}
          <div className="flex gap-1">
            {filters.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`px-3 py-1.5 text-[13px] font-medium rounded-full transition-colors ${
                  filter === f.key
                    ? 'bg-text-primary text-surface-1'
                    : 'text-text-desc hover:text-text-primary hover:bg-surface-2'
                }`}
              >
                {f.label}
                {f.count > 0 && (
                  <span className={`ml-1.5 text-[12px] ${filter === f.key ? 'text-surface-1 opacity-70' : 'text-text-desc'}`}>
                    {f.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="flex-1" />

          {/* Search */}
          <input
            type="text"
            placeholder="Search tasks..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-[200px] px-3 py-1.5 text-[13px] rounded-md border border-border-strong bg-transparent text-text-primary placeholder:text-text-muted focus:outline-none focus:border-text-secondary"
          />

          {/* Group by dropdown */}
          <Select
            value={groupBy}
            onChange={(v) => setGroupBy(v as GroupBy)}
            options={[
              { value: 'mission', label: 'Group: Mission' },
              { value: 'status', label: 'Group: Status' },
              { value: 'none', label: 'Group: None' },
            ]}
            size="sm"
          />
        </div>

        {/* Task list */}
        <div className="border-t border-border-default">
          {/* Needs Input — pinned section */}
          {needsInputTasks.length > 0 && (
            <div className="bg-status-warning/8">
              {/* Header */}
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-default">
                <span className="w-2 h-2 rounded-full bg-status-warning" />
                <span className="text-[13px] font-semibold text-text-primary">Needs Input</span>
                <span className="text-[12px] text-text-desc">{needsInputTasks.length}</span>
              </div>
              {/* Rows */}
              {needsInputTasks.map((task) => {
                const dot = getStatusDot(task.status);
                return (
                  <Link
                    key={task.id}
                    href={`/app/tasks/${task.id}`}
                    className="flex items-center gap-3 px-4 py-2.5 border-b border-border-default/60 hover:bg-status-warning/12 transition-colors"
                  >
                    <span className={`w-2 h-2 rounded-full shrink-0 ${dot.color}`} />
                    <span className="text-[14px] text-text-primary truncate min-w-0 flex-1">{task.title}</span>
                    <span className="inline-flex items-center px-1.5 py-0.5 text-[11px] font-mono rounded-md bg-surface-3 text-text-secondary shrink-0">
                      {task.workspaceName}
                    </span>
                    {task.missionTitle && (
                      <span className="text-[12px] text-text-muted truncate max-w-[160px] shrink-0 hidden sm:inline">
                        {task.missionTitle}
                      </span>
                    )}
                    <span className="text-[12px] text-text-desc shrink-0 w-[70px] text-right">
                      {timeAgo(task.updatedAt)}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}

          {/* Grouped by Mission */}
          {groupBy === 'mission' && missionGroups.map((group) => {
            const groupId = group.id || '__no_mission__';
            const isCollapsed = collapsedGroups.has(groupId);

            return (
              <div key={groupId}>
                {/* Group header */}
                <button
                  onClick={() => toggleGroup(groupId)}
                  className="w-full flex items-center gap-2 px-4 py-2.5 border-b border-border-default bg-surface-1 hover:bg-surface-2/50 transition-colors text-left"
                >
                  <span className={`text-[11px] text-text-muted transition-transform ${isCollapsed ? '-rotate-90' : ''}`}>
                    &#9662;
                  </span>
                  <span className="text-[13px] font-semibold text-text-primary">{group.title}</span>
                  {group.missionType && (
                    <span className="inline-flex items-center px-1.5 py-0.5 text-[11px] font-mono rounded bg-surface-3 text-text-secondary">
                      {group.missionType}
                    </span>
                  )}
                  <span className="text-[12px] text-text-desc ml-auto">
                    {group.tasks.length} {group.tasks.length === 1 ? 'task' : 'tasks'}
                  </span>
                </button>
                {/* Task rows */}
                {!isCollapsed && group.tasks.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </div>
            );
          })}

          {/* Grouped by Status */}
          {groupBy === 'status' && statusGroups.map((group) => {
            const groupId = `status_${group.label}`;
            const isCollapsed = collapsedGroups.has(groupId);

            return (
              <div key={groupId}>
                <button
                  onClick={() => toggleGroup(groupId)}
                  className="w-full flex items-center gap-2 px-4 py-2.5 border-b border-border-default bg-surface-1 hover:bg-surface-2/50 transition-colors text-left"
                >
                  <span className={`text-[11px] text-text-muted transition-transform ${isCollapsed ? '-rotate-90' : ''}`}>
                    &#9662;
                  </span>
                  <span className="text-[13px] font-semibold text-text-primary">{group.label}</span>
                  <span className="text-[12px] text-text-desc ml-auto">
                    {group.tasks.length} {group.tasks.length === 1 ? 'task' : 'tasks'}
                  </span>
                </button>
                {!isCollapsed && group.tasks.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </div>
            );
          })}

          {/* Flat list (no grouping) */}
          {groupBy === 'none' && flatSorted.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}

          {/* Empty filtered state */}
          {filtered.length === 0 && visibleTasks.length > 0 && (
            <div className="text-center py-12">
              <p className="text-text-muted text-sm">No tasks match this filter.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
