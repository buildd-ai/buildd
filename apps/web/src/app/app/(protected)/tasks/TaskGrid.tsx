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

// Sort strictly by recency — status is never a sort key
function sortByRecency(list: GridTask[]): GridTask[] {
  return [...list].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

type FilterStatus = 'all' | 'active' | 'completed' | 'failed';
type ContentFilter = 'all' | 'missions' | 'tasks';
type GroupBy = 'mission' | 'none' | 'status' | 'workspace';

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

// Small icon that distinguishes standalone tasks from mission-grouped ones
function StandaloneIcon() {
  return (
    <span
      title="Standalone task"
      className="inline-flex items-center justify-center w-4 h-4 rounded border border-border-default text-text-muted shrink-0"
    >
      <svg viewBox="0 0 12 12" fill="none" className="w-2.5 h-2.5" stroke="currentColor" strokeWidth={1.5}>
        <rect x="1.5" y="1.5" width="9" height="9" rx="1" />
        <path d="M3.5 5.5h5M3.5 7.5h3" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function TaskRow({ task, isStandalone }: { task: GridTask; isStandalone?: boolean }) {
  const dot = getStatusDot(task.status);
  const isCompleted = task.status === 'completed';

  return (
    <Link
      href={`/app/tasks/${task.id}`}
      className="flex items-center gap-3 px-4 py-2.5 border-b border-border-default hover:bg-surface-2/50 transition-colors"
    >
      {/* Status dot */}
      <span className={`w-2 h-2 rounded-full shrink-0 ${dot.color} ${dot.pulse ? 'animate-pulse' : ''}`} />

      {/* Standalone icon — only shown when not inside a named mission group */}
      {isStandalone && <StandaloneIcon />}

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
  const visibleTasks = useMemo(() => {
    if (!missionFilter) return tasks;
    return tasks.filter(t => t.missionId === missionFilter);
  }, [tasks, missionFilter]);

  const [filter, setFilter] = useState<FilterStatus>('all');
  const [contentFilter, setContentFilter] = useState<ContentFilter>('all');
  const [groupBy, setGroupBy] = useState<GroupBy>(missionFilter ? 'none' : 'mission');
  const [search, setSearch] = useState('');
  // Empty = all collapsed by default. Toggling adds a group to expandedGroups to open it.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Counts from unfiltered tasks
  const allCount = visibleTasks.length;
  const activeCount = visibleTasks.filter(t => ['in_progress', 'assigned', 'waiting_input', 'pending'].includes(t.status)).length;
  const completedCount = visibleTasks.filter(t => t.status === 'completed').length;
  const failedCount = visibleTasks.filter(t => t.status === 'failed').length;

  const filtered = useMemo(() => {
    let result = visibleTasks;

    if (filter === 'active') result = result.filter(t => ['in_progress', 'assigned', 'waiting_input', 'pending'].includes(t.status));
    else if (filter === 'completed') result = result.filter(t => t.status === 'completed');
    else if (filter === 'failed') result = result.filter(t => t.status === 'failed');

    // Content type filter
    if (contentFilter === 'missions') result = result.filter(t => t.missionId !== null);
    else if (contentFilter === 'tasks') result = result.filter(t => t.missionId === null);

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(t => t.title.toLowerCase().includes(q));
    }

    return result;
  }, [visibleTasks, filter, contentFilter, search]);

  // Needs-input tasks pinned at top regardless of grouping
  const needsInputTasks = useMemo(() => filtered.filter(t => t.status === 'waiting_input'), [filtered]);
  const nonWaitingTasks = useMemo(() => filtered.filter(t => t.status !== 'waiting_input'), [filtered]);

  const missionGroups = useMemo((): MissionGroup[] => {
    if (groupBy !== 'mission') return [];
    const map = new Map<string | null, GridTask[]>();
    for (const t of nonWaitingTasks) {
      const existing = map.get(t.missionId) || [];
      existing.push(t);
      map.set(t.missionId, existing);
    }
    const groups: MissionGroup[] = [];
    for (const [id, groupTasks] of map) {
      const sorted = sortByRecency(groupTasks);
      // Deduplicate planning-cycle rows: within named mission groups, drop tasks with
      // the same title as a more-recent sibling (heartbeat/planning tasks repeat once per run).
      let deduped: GridTask[];
      if (id !== null) {
        const seenTitles = new Set<string>();
        deduped = [];
        for (const t of sorted) {
          if (!seenTitles.has(t.title)) {
            seenTitles.add(t.title);
            deduped.push(t);
          }
        }
      } else {
        deduped = sorted;
      }
      groups.push({
        id,
        title: id ? (groupTasks[0].missionTitle || 'Untitled mission') : 'No mission',
        tasks: deduped,
      });
    }
    // Sort groups by latest activity (max updatedAt) descending.
    // No special "No mission at bottom" rule — let recency decide.
    groups.sort((a, b) => {
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
    return order
      .map(({ key, label }) => ({
        label,
        tasks: sortByRecency(nonWaitingTasks.filter(t => t.status === key)),
      }))
      .filter(g => g.tasks.length > 0);
  }, [nonWaitingTasks, groupBy]);

  const workspaceGroups = useMemo((): MissionGroup[] => {
    if (groupBy !== 'workspace') return [];
    const map = new Map<string, GridTask[]>();
    for (const t of nonWaitingTasks) {
      const existing = map.get(t.workspaceName) || [];
      existing.push(t);
      map.set(t.workspaceName, existing);
    }
    const groups: MissionGroup[] = [];
    for (const [name, groupTasks] of map) {
      groups.push({ id: name, title: name, tasks: sortByRecency(groupTasks) });
    }
    groups.sort((a, b) => {
      const aLatest = Math.max(...a.tasks.map(t => new Date(t.updatedAt).getTime()));
      const bLatest = Math.max(...b.tasks.map(t => new Date(t.updatedAt).getTime()));
      return bLatest - aLatest;
    });
    return groups;
  }, [nonWaitingTasks, groupBy]);

  const flatSorted = useMemo(() => {
    if (groupBy !== 'none') return [];
    return sortByRecency(nonWaitingTasks);
  }, [nonWaitingTasks, groupBy]);

  const toggleGroup = (groupId: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  if (visibleTasks.length === 0 && !missionFilter) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="w-16 h-16 mx-auto bg-surface-3 rounded-full flex items-center justify-center mb-4">
            <svg className="w-8 h-8 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-text-primary mb-2">No activity yet</h2>
          <p className="text-text-secondary mb-4">Tasks from your missions will appear here.</p>
          <Link
            href="/app/missions/new"
            className="inline-flex items-center px-4 py-2 bg-primary text-white rounded-md hover:bg-primary-hover"
          >
            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Mission
          </Link>
        </div>
      </div>
    );
  }

  const statusFilters: { key: FilterStatus; label: string; count: number }[] = [
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
        <div className="flex items-center justify-between px-4 mb-3">
          <h1 className="text-[28px] font-bold text-text-primary" style={{ fontFamily: 'var(--font-display, inherit)' }}>
            {missionFilter ? (missionTitle || 'Mission Tasks') : 'Activity'}
          </h1>
        </div>

        {/* Content type segmented filter: All / Missions / Tasks */}
        {!missionFilter && (
          <div className="flex items-center gap-1 px-4 mb-3">
            {([
              { key: 'all' as ContentFilter, label: 'All' },
              { key: 'missions' as ContentFilter, label: 'Missions' },
              { key: 'tasks' as ContentFilter, label: 'Tasks' },
            ]).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setContentFilter(key)}
                className={`px-3 py-1 text-[13px] font-medium rounded-full transition-colors ${
                  contentFilter === key
                    ? 'bg-surface-3 text-text-primary'
                    : 'text-text-muted hover:text-text-secondary hover:bg-surface-2'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Filter + search bar */}
        <div className="flex items-center gap-2 px-4 mb-4 flex-wrap">
          {/* Status tabs */}
          <div className="flex gap-1">
            {statusFilters.map((f) => (
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
            className="w-[160px] sm:w-[200px] px-3 py-1.5 text-[13px] rounded-md border border-border-strong bg-transparent text-text-primary placeholder:text-text-muted focus:outline-none focus:border-text-secondary"
          />

          {/* Group by dropdown */}
          <Select
            value={groupBy}
            onChange={(v) => setGroupBy(v as GroupBy)}
            options={[
              { value: 'mission', label: 'Group: Mission' },
              { value: 'workspace', label: 'Group: Workspace' },
              { value: 'status', label: 'Group: Status' },
              { value: 'none', label: 'Group: None' },
            ]}
            size="sm"
          />
        </div>

        {/* Task list */}
        <div className="border-t border-border-default">
          {/* Needs Input — always pinned at the top */}
          {needsInputTasks.length > 0 && (
            <div className="bg-status-warning/8">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-default">
                <span className="w-2 h-2 rounded-full bg-status-warning" />
                <span className="text-[13px] font-semibold text-text-primary">Needs Input</span>
                <span className="text-[12px] text-text-desc">{needsInputTasks.length}</span>
              </div>
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
            const isExpanded = expandedGroups.has(groupId);
            const isNoMission = group.id === null;
            const latestMs = Math.max(...group.tasks.map(t => new Date(t.updatedAt).getTime()));
            const completedInGroup = group.tasks.filter(t => t.status === 'completed').length;

            return (
              <div key={groupId}>
                <button
                  onClick={() => toggleGroup(groupId)}
                  className="w-full flex items-center gap-2 px-4 py-2.5 border-b border-border-default bg-surface-1 hover:bg-surface-2/50 transition-colors text-left"
                >
                  {/* Chevron: points right when collapsed, down when expanded */}
                  <span className={`text-[11px] text-text-muted transition-transform shrink-0 ${isExpanded ? '' : '-rotate-90'}`}>
                    &#9662;
                  </span>

                  {/* Mission icon (only for named missions) */}
                  {!isNoMission && (
                    <svg className="w-3 h-3 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <circle cx="12" cy="12" r="3" />
                      <circle cx="12" cy="12" r="9" strokeDasharray="2 4" />
                    </svg>
                  )}

                  <span className="text-[13px] font-semibold text-text-primary truncate min-w-0 flex-1">
                    {group.title}
                  </span>

                  {/* Progress (for named missions) */}
                  {!isNoMission && group.tasks.length > 0 && (
                    <span className="text-[11px] text-text-muted shrink-0">
                      {completedInGroup}/{group.tasks.length}
                    </span>
                  )}

                  <span className="text-[12px] text-text-desc shrink-0">
                    {group.tasks.length} {group.tasks.length === 1 ? 'task' : 'tasks'}
                  </span>

                  <span className="text-[11px] text-text-muted shrink-0 w-[58px] text-right">
                    {timeAgo(new Date(latestMs).toISOString())}
                  </span>
                </button>

                {isExpanded && group.tasks.map((task) => (
                  <TaskRow key={task.id} task={task} isStandalone={isNoMission} />
                ))}
              </div>
            );
          })}

          {/* Grouped by Status */}
          {groupBy === 'status' && statusGroups.map((group) => {
            const groupId = `status_${group.label}`;
            const isExpanded = expandedGroups.has(groupId);

            return (
              <div key={groupId}>
                <button
                  onClick={() => toggleGroup(groupId)}
                  className="w-full flex items-center gap-2 px-4 py-2.5 border-b border-border-default bg-surface-1 hover:bg-surface-2/50 transition-colors text-left"
                >
                  <span className={`text-[11px] text-text-muted transition-transform shrink-0 ${isExpanded ? '' : '-rotate-90'}`}>
                    &#9662;
                  </span>
                  <span className="text-[13px] font-semibold text-text-primary">{group.label}</span>
                  <span className="text-[12px] text-text-desc ml-auto">
                    {group.tasks.length} {group.tasks.length === 1 ? 'task' : 'tasks'}
                  </span>
                </button>
                {isExpanded && group.tasks.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </div>
            );
          })}

          {/* Grouped by Workspace */}
          {groupBy === 'workspace' && workspaceGroups.map((group) => {
            const groupId = `ws_${group.id}`;
            const isExpanded = expandedGroups.has(groupId);

            return (
              <div key={groupId}>
                <button
                  onClick={() => toggleGroup(groupId)}
                  className="w-full flex items-center gap-2 px-4 py-2.5 border-b border-border-default bg-surface-1 hover:bg-surface-2/50 transition-colors text-left"
                >
                  <span className={`text-[11px] text-text-muted transition-transform shrink-0 ${isExpanded ? '' : '-rotate-90'}`}>
                    &#9662;
                  </span>
                  <span className="text-[13px] font-semibold text-text-primary">{group.title}</span>
                  <span className="text-[12px] text-text-desc ml-auto">
                    {group.tasks.length} {group.tasks.length === 1 ? 'task' : 'tasks'}
                  </span>
                </button>
                {isExpanded && group.tasks.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </div>
            );
          })}

          {/* Flat list (no grouping) */}
          {groupBy === 'none' && flatSorted.map((task) => (
            <TaskRow key={task.id} task={task} isStandalone={!task.missionId} />
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
