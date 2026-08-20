'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { WorkspaceFilter } from '@/components/WorkspaceFilter';
import LocalTime from './LocalTime';
import { TaskCard } from '@/components/TaskCard';
import { GroupSection } from '@/components/GroupSection';
import { SwipeableRow, SwipeProvider, type SwipeCardType } from '@/components/SwipeableRow';
import { deriveBandKey } from '@/lib/condensed-timeline';
import type { ChainPositionResult } from '@/lib/task-presentation';
import type { LoopState } from '@buildd/shared';
import type { TaskType } from '@buildd/core/mission-helpers';
import type { StageCounts } from '@/components/MissionProgressBar';

interface GridTask {
  id: string;
  title: string;
  status: string;
  category: string | null;
  createdAt: string;
  updatedAt: string;
  workspaceName: string;
  prUrl: string | null;
  prNumber: number | null;
  prLifecycleStatus?: string | null;
  summary: string | null;
  hasArtifact: boolean;
  filesChanged: number | null;
  waitingPrompt: string | null;
  missionId: string | null;
  missionTitle: string | null;
  budgetPaused?: boolean;
  budgetBackend?: string;
  budgetResetsAt?: string | null;
  startAt?: string | null;
  loopIteration?: number | null;
  loopState?: LoopState | null;
  loopMaxLoops?: number | null;
  workerStatus?: string | null;
  workerStartedAt?: string | null;
  workerUpdatedAt?: string | null;
  runnerName?: string | null;
  chain?: ChainPositionResult | null;
  attemptCurrent?: number | null;
  attemptTotal?: number | null;
  taskType?: TaskType | null;
  taskClass?: string | null;
  parentTaskId?: string | null;
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

function deriveSwipeCardType(task: GridTask): SwipeCardType {
  if (task.status === 'completed') return 'completed-task';
  if (task.chain?.blockedBy && task.chain.blockedBy.length > 0) return 'blocked-task';
  return 'running-task';
}

function renderTaskCard(
  task: GridTask,
  missionScoped = false,
  groupScoped = false,
  groupTaskIds?: ReadonlySet<string>,
) {
  const cardType = deriveSwipeCardType(task);
  const swipePrUrl = cardType === 'blocked-task'
    ? (task.chain?.blockedBy?.[0]?.prUrl ?? task.prUrl)
    : task.prUrl;
  return (
    <SwipeableRow
      key={task.id}
      cardType={cardType}
      taskTitle={task.title}
      prUrl={swipePrUrl}
      taskId={task.id}
    >
      <TaskCard
        id={task.id}
        title={task.title}
        taskStatus={task.status}
        workerStatus={task.workerStatus}
        missionId={task.missionId}
        missionTitle={missionScoped ? null : task.missionTitle}
        workspaceName={task.workspaceName}
        chain={task.chain}
        taskCreatedAt={task.createdAt}
        taskUpdatedAt={task.updatedAt}
        startAt={task.startAt}
        loopIteration={task.loopIteration}
        loopState={task.loopState}
        loopMaxLoops={task.loopMaxLoops}
        workerStartedAt={task.workerStartedAt}
        workerUpdatedAt={task.workerUpdatedAt}
        attemptCurrent={task.attemptCurrent}
        attemptTotal={task.attemptTotal}
        runnerName={task.runnerName}
        prUrl={task.prUrl}
        prNumber={task.prNumber}
        taskType={task.taskType}
        density="row"
        groupScoped={groupScoped}
        groupTaskIds={groupTaskIds}
      />
    </SwipeableRow>
  );
}

function renderTaskWithChildren(
  task: GridTask,
  childrenByParentId: Map<string, GridTask[]>,
  expandedParents: Set<string>,
  onToggle: (id: string) => void,
  missionScoped: boolean,
  groupScoped = false,
  groupTaskIds?: ReadonlySet<string>,
) {
  const children = [...(childrenByParentId.get(task.id) ?? [])].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  const hasChildren = children.length > 0;
  const isExpanded = expandedParents.has(task.id);
  const childLabel = children.length === 1 ? 'attempt' : 'attempts';

  // Elbow rail indentation for blocked tasks when blocker is in same group
  const isBlocked = (task.chain?.blockedBy?.length ?? 0) > 0;
  const blockerVisible = groupScoped && isBlocked && !!groupTaskIds &&
    (task.chain?.blockedBy ?? []).every(b => groupTaskIds.has(b.id));

  return (
    <div key={task.id} className={blockerVisible ? 'ml-4 border-l border-status-warning/50' : ''}>
      {renderTaskCard(task, missionScoped, groupScoped, groupTaskIds)}
      {hasChildren && (
        <div>
          <button
            onClick={() => onToggle(task.id)}
            className="flex items-center gap-1.5 pl-10 pr-4 py-1 text-[11px] font-medium text-text-muted hover:text-text-secondary transition-colors w-full text-left border-b border-border-default"
          >
            <span className={`text-[9px] leading-none transition-transform duration-150 ${isExpanded ? 'rotate-0' : '-rotate-90'}`}>
              &#9662;
            </span>
            {isExpanded
              ? `${children.length} ${childLabel}`
              : `+${children.length} ${childLabel}`
            }
          </button>
          {isExpanded && (
            <div className="border-l-2 border-border-default ml-10">
              {children.map(child => (
                <div key={child.id}>
                  {renderTaskCard(child, missionScoped, groupScoped, groupTaskIds)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Sort strictly by recency — status is never a sort key
function sortByRecency(list: GridTask[]): GridTask[] {
  return [...list].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

type FilterStatus = 'all' | 'active' | 'completed' | 'failed';
type ContentFilter = 'all' | 'missions' | 'tasks' | 'retries' | 'reviews';
type GroupBy = 'mission' | 'none' | 'status' | 'workspace' | 'time';

interface MissionGroup {
  id: string | null;
  title: string;
  tasks: GridTask[];
}

// ─── Stage derivation from GridTask (no new column needed) ───────────────────

function deriveGridTaskStage(task: GridTask): keyof StageCounts {
  if (task.status === 'failed') return 'FAILED';
  if (task.workerStatus === 'running' || task.workerStatus === 'starting' ||
      task.workerStatus === 'idle' || task.workerStatus === 'waiting_input') return 'RUNNING';
  if (task.status === 'completed') {
    const merged = task.prLifecycleStatus === 'merged';
    if (task.prUrl && !merged) return 'REVIEW';
    return 'DONE';
  }
  if (task.status === 'pending' || task.status === 'assigned') {
    if ((task.chain?.blockedBy?.length ?? 0) > 0) return 'BLOCKED';
    return 'QUEUED';
  }
  return 'QUEUED';
}

function computeStageCounts(tasks: GridTask[]): { counts: StageCounts; failedCount: number } {
  const counts: StageCounts = { BLOCKED: 0, QUEUED: 0, RUNNING: 0, REVIEW: 0, DONE: 0, FAILED: 0 };
  for (const t of tasks) {
    counts[deriveGridTaskStage(t)]++;
  }
  const failedCount = counts.FAILED;
  // FAILED doesn't go in the bar segments
  counts.FAILED = 0;
  return { counts, failedCount };
}

interface StatusGroup {
  label: string;
  tasks: GridTask[];
}

interface TaskGridProps {
  tasks: GridTask[];
  missionFilter?: string | null;
  missionTitle?: string | null;
  workspaces?: { id: string; name: string }[];
  selectedWorkspaceId?: string | null;
  initiativeFilter?: string | null;
  initiativeTitle?: string | null;
  initiativeMissionIds?: string[];
}

export default function TaskGrid({ tasks, missionFilter, missionTitle, workspaces, selectedWorkspaceId, initiativeFilter, initiativeTitle, initiativeMissionIds }: TaskGridProps) {
  const router = useRouter();

  const visibleTasks = useMemo(() => {
    if (missionFilter) return tasks.filter(t => t.missionId === missionFilter);
    if (initiativeMissionIds && initiativeMissionIds.length > 0) {
      return tasks.filter(t => t.missionId !== null && initiativeMissionIds.includes(t.missionId));
    }
    return tasks;
  }, [tasks, missionFilter, initiativeMissionIds]);

  // Split tasks: roots are 'work' tasks (genuine deliverables), children are 'attempt' tasks
  // (CI retries, reviewer runs) that nest under their parent work task.
  const rootTasks = useMemo(() => visibleTasks.filter(t => t.taskClass === 'work'), [visibleTasks]);
  const childrenByParentId = useMemo(() => {
    const map = new Map<string, GridTask[]>();
    for (const t of visibleTasks) {
      if (t.taskClass === 'attempt' && t.parentTaskId) {
        const existing = map.get(t.parentTaskId) ?? [];
        existing.push(t);
        map.set(t.parentTaskId, existing);
      }
    }
    return map;
  }, [visibleTasks]);

  const [filter, setFilter] = useState<FilterStatus>('all');
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  const [contentFilter, setContentFilter] = useState<ContentFilter>('all');
  // Default grouping is time-band; mission is a user-selectable lens
  const [groupLens, setGroupLens] = useState<'time' | 'mission'>('time');
  const groupBy: GroupBy = missionFilter ? 'none' : groupLens;
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Focus search input when mobile search opens
  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  const toggleSearch = useCallback(() => {
    if (searchOpen) {
      setSearch('');
      setSearchOpen(false);
    } else {
      setSearchOpen(true);
    }
  }, [searchOpen]);

  // Load persisted filter from localStorage on mount
  useEffect(() => {
    if (missionFilter) return; // don't persist when scoped to a mission
    try {
      const stored = localStorage.getItem('buildd-activity-prefs');
      if (stored) {
        const prefs = JSON.parse(stored) as { filter?: FilterStatus };
        if (prefs.filter) setFilter(prefs.filter);
      }
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateFilter = useCallback((f: FilterStatus) => {
    setFilter(f);
    if (missionFilter) return;
    try {
      const stored = JSON.parse(localStorage.getItem('buildd-activity-prefs') || '{}');
      localStorage.setItem('buildd-activity-prefs', JSON.stringify({ ...stored, filter: f }));
    } catch {}
  }, [missionFilter]);

  const dismissInitiative = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete('initiative');
    const qs = params.toString();
    router.push(`/app/tasks${qs ? `?${qs}` : ''}`);
  }, [router]);

  const toggleParent = useCallback((taskId: string) => {
    setExpandedParents(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  // Counts from root tasks only (children are shown nested)
  const allCount = rootTasks.length;
  const activeCount = rootTasks.filter(t => ['running', 'in_progress', 'assigned', 'waiting_input', 'pending'].includes(t.status)).length;
  const completedCount = rootTasks.filter(t => t.status === 'completed').length;
  const failedCount = rootTasks.filter(t => t.status === 'failed').length;

  const filtered = useMemo(() => {
    let result = rootTasks;

    if (filter === 'active') result = result.filter(t => ['running', 'in_progress', 'assigned', 'waiting_input', 'pending'].includes(t.status));
    else if (filter === 'completed') result = result.filter(t => t.status === 'completed');
    else if (filter === 'failed') result = result.filter(t => t.status === 'failed');

    // Content type filter
    if (contentFilter === 'missions') result = result.filter(t => t.missionId !== null);
    else if (contentFilter === 'tasks') result = result.filter(t => t.missionId === null);
    else if (contentFilter === 'retries') result = result.filter(t => t.taskType === 'retry');
    else if (contentFilter === 'reviews') result = result.filter(t => t.taskType === 'review' || t.taskType === 'review-retry');

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(t => t.title.toLowerCase().includes(q));
    }

    return result;
  }, [rootTasks, filter, contentFilter, search]);

  // Needs-input tasks pinned at top regardless of grouping
  const needsInputTasks = useMemo(() => filtered.filter(t => t.status === 'waiting_input'), [filtered]);
  const nonWaitingTasks = useMemo(() => filtered.filter(t => t.status !== 'waiting_input'), [filtered]);

  // Auto-flatten: when groupBy=mission but one group holds >75% of tasks, switch to flat recency list.
  // This prevents the degenerate "No mission" single-bucket scenario.
  const effectiveGroupBy = useMemo((): GroupBy => {
    if (groupBy !== 'mission' || nonWaitingTasks.length === 0) return groupBy;
    const groupCounts = new Map<string | null, number>();
    for (const t of nonWaitingTasks) {
      groupCounts.set(t.missionId, (groupCounts.get(t.missionId) ?? 0) + 1);
    }
    const maxCount = Math.max(...groupCounts.values());
    return maxCount / nonWaitingTasks.length > 0.75 ? 'none' : groupBy;
  }, [groupBy, nonWaitingTasks]);

  // ─── Time-band groups — §3.8: shared deriveBandKey (gap-clustered bands) ────

  const timeBandGroups = useMemo(() => {
    if (effectiveGroupBy !== 'time') return [];
    const withTs = nonWaitingTasks.map(t => ({
      ...t,
      completionTs: new Date(t.updatedAt).getTime(),
    }));
    return deriveBandKey(withTs, new Date());
  }, [nonWaitingTasks, effectiveGroupBy]);

  // Mobile recent strip: top 5 non-completed root tasks by recency, always visible regardless of filter
  const mobileRecentTasks = useMemo(() => {
    if (missionFilter) return [];
    return [...rootTasks]
      .filter(t => ['running', 'in_progress', 'assigned', 'waiting_input', 'pending'].includes(t.status))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 5);
  }, [rootTasks, missionFilter]);

  const missionGroups = useMemo((): MissionGroup[] => {
    if (effectiveGroupBy !== 'mission') return [];
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
  }, [nonWaitingTasks, effectiveGroupBy]);

  const statusGroups = useMemo((): StatusGroup[] => {
    if (effectiveGroupBy !== 'status') return [];
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
  }, [nonWaitingTasks, effectiveGroupBy]);

  const workspaceGroups = useMemo((): MissionGroup[] => {
    if (effectiveGroupBy !== 'workspace') return [];
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
  }, [nonWaitingTasks, effectiveGroupBy]);

  const flatSorted = useMemo(() => {
    if (effectiveGroupBy !== 'none') return [];
    return sortByRecency(nonWaitingTasks);
  }, [nonWaitingTasks, effectiveGroupBy]);

  if (rootTasks.length === 0 && !missionFilter) {
    return (
      <div className="h-full flex items-center justify-center p-8 pt-20 md:pt-8">
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
    <SwipeProvider>
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1000px] mx-auto pt-14 pb-4 md:py-4">
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
        <div className="flex items-center gap-3 px-4 mb-3">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <h1 className="text-[28px] font-bold text-text-primary shrink-0" style={{ fontFamily: 'var(--font-display, inherit)' }}>
              {missionFilter ? (missionTitle || 'Mission Tasks') : 'Activity'}
            </h1>
            {initiativeFilter && (
              <span className="flex items-center gap-1 px-2.5 py-1 text-[12px] font-medium rounded-full bg-surface-3 text-text-secondary border border-border-default shrink-0 max-w-[180px]">
                <span className="truncate">{initiativeTitle || 'Initiative'}</span>
                <button
                  onClick={dismissInitiative}
                  aria-label="Remove initiative filter"
                  className="ml-0.5 text-text-muted hover:text-text-primary leading-none shrink-0"
                >
                  ×
                </button>
              </span>
            )}
          </div>
          {!missionFilter && workspaces && (
            <WorkspaceFilter workspaces={workspaces} selectedId={selectedWorkspaceId ?? null} />
          )}
        </div>

        {/* Mobile filter UI: single scrollable chip row + optional search */}
        <div className="sm:hidden">
          {/* Combined scrollable chip row — type chips | status chips | search toggle */}
          {!missionFilter && (
            <div className="flex items-center gap-2 mb-2">
              {/* Chips scroll area — wrapper pattern ensures right-side padding isn't clipped */}
              <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1">
                <div className="flex items-center gap-1.5 pl-4 pr-2 min-w-max">
                  {/* Type chips */}
                  {([
                    { key: 'all' as ContentFilter, label: 'All' },
                    { key: 'missions' as ContentFilter, label: 'Missions' },
                    { key: 'tasks' as ContentFilter, label: 'Tasks' },
                    { key: 'retries' as ContentFilter, label: '↻ Retries' },
                    { key: 'reviews' as ContentFilter, label: '⬡ Reviews' },
                  ]).map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => setContentFilter(key)}
                      className={`shrink-0 px-2.5 py-1 text-[12px] font-medium rounded-full transition-colors whitespace-nowrap ${
                        contentFilter === key
                          ? 'bg-surface-3 text-text-primary'
                          : 'text-text-muted'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                  {/* Visual divider */}
                  <span className="shrink-0 w-px h-4 bg-border-default mx-0.5" />
                  {/* Group lens chip */}
                  <button
                    onClick={() => setGroupLens(g => g === 'time' ? 'mission' : 'time')}
                    className={`shrink-0 px-2.5 py-1 text-[12px] font-medium rounded-full transition-colors whitespace-nowrap ${
                      groupLens === 'mission'
                        ? 'bg-surface-3 text-text-primary'
                        : 'text-text-muted'
                    }`}
                  >
                    {groupLens === 'mission' ? '⊙ Missions' : '⊙ By time'}
                  </button>
                  {/* Visual divider */}
                  <span className="shrink-0 w-px h-4 bg-border-default mx-0.5" />
                  {/* Status chips — tap active chip to deselect (returns to all) */}
                  {statusFilters.filter(f => f.key !== 'all').map((f) => (
                    <button
                      key={f.key}
                      onClick={() => updateFilter(filter === f.key ? 'all' : f.key)}
                      className={`shrink-0 px-2.5 py-1 text-[12px] font-medium rounded-full transition-colors whitespace-nowrap ${
                        filter === f.key
                          ? 'bg-text-primary text-surface-1'
                          : f.count === 0
                            ? 'text-text-muted/50'
                            : 'text-text-desc'
                      }`}
                    >
                      {f.label}
                      {f.count > 0 && (
                        <span className={`ml-1 text-[11px] ${filter === f.key ? 'text-surface-1 opacity-70' : 'text-text-desc'}`}>
                          {f.count}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
              {/* Search toggle — fixed right, doesn't scroll with chips */}
              <button
                onClick={toggleSearch}
                aria-label={searchOpen ? 'Close search' : 'Search tasks'}
                className={`shrink-0 mr-4 p-1.5 rounded-md transition-colors ${
                  searchOpen
                    ? 'bg-surface-3 text-text-primary'
                    : 'text-text-muted hover:text-text-secondary hover:bg-surface-2'
                }`}
              >
                {searchOpen ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                )}
              </button>
            </div>
          )}
          {/* Expanded search input (conditional) */}
          {searchOpen && (
            <div className="px-4 mb-3">
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search tasks..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full px-3 py-1.5 text-[13px] rounded-md border border-border-strong bg-transparent text-text-primary placeholder:text-text-muted focus:outline-none focus:border-text-secondary"
              />
            </div>
          )}
        </div>

        {/* Desktop filter UI — single chip row: type | status chips + search */}
        {!missionFilter && (
          <div className="hidden sm:flex items-center gap-2 px-4 mb-4 flex-wrap">
            {/* Content type chips */}
            {([
              { key: 'all' as ContentFilter, label: 'All' },
              { key: 'missions' as ContentFilter, label: 'Missions' },
              { key: 'tasks' as ContentFilter, label: 'Tasks' },
              { key: 'retries' as ContentFilter, label: '↻ Re-runs' },
              { key: 'reviews' as ContentFilter, label: '⬡ Reviews' },
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
            {/* Divider */}
            <span className="w-px h-4 bg-border-default mx-0.5" />
            {/* Group lens chip */}
            <button
              onClick={() => setGroupLens(g => g === 'time' ? 'mission' : 'time')}
              className={`px-3 py-1 text-[13px] font-medium rounded-full transition-colors ${
                groupLens === 'mission'
                  ? 'bg-surface-3 text-text-primary'
                  : 'text-text-muted hover:text-text-secondary hover:bg-surface-2'
              }`}
            >
              {groupLens === 'mission' ? '⊙ By mission' : '⊙ By time'}
            </button>
            {/* Divider */}
            <span className="w-px h-4 bg-border-default mx-0.5" />
            {/* Status chips — tap active chip to deselect (returns to all) */}
            {statusFilters.filter(f => f.key !== 'all').map((f) => (
              <button
                key={f.key}
                onClick={() => updateFilter(filter === f.key ? 'all' : f.key)}
                className={`px-3 py-1 text-[13px] font-medium rounded-full transition-colors ${
                  filter === f.key
                    ? 'bg-text-primary text-surface-1'
                    : f.count === 0
                      ? 'text-text-muted/50'
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
            <div className="flex-1" />
            <input
              type="text"
              placeholder="Search tasks..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-[200px] px-3 py-1.5 text-[13px] rounded-md border border-border-strong bg-transparent text-text-primary placeholder:text-text-muted focus:outline-none focus:border-text-secondary"
            />
          </div>
        )}

        {/* Mobile recent-tasks strip: always visible on mobile, regardless of filter/grouping.
            Gives a one-tap path to the most recently active tasks without navigating filters. */}
        {!missionFilter && mobileRecentTasks.length > 0 && filter !== 'active' && (
          <div className="sm:hidden px-4 mb-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-mono uppercase tracking-wide text-text-muted">Running now</span>
              <button
                onClick={() => updateFilter('active')}
                className="text-[12px] text-accent-text hover:underline"
              >
                All active →
              </button>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 snap-x">
              {mobileRecentTasks.map(task => (
                <Link
                  key={task.id}
                  href={`/app/tasks/${task.id}`}
                  className="flex-shrink-0 snap-start border border-border-strong bg-surface-2/50 px-3 py-2 w-[180px]"
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-status-info animate-pulse" />
                    <span className="text-[11px] text-text-muted font-mono">
                      {task.workspaceName}
                    </span>
                  </div>
                  <div className="text-[13px] text-text-primary line-clamp-2 leading-snug">
                    {task.title}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

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
              <div className="px-2">
                {needsInputTasks.map((task) => renderTaskWithChildren(task, childrenByParentId, expandedParents, toggleParent, !!missionFilter))}
              </div>
            </div>
          )}

          {/* Grouped by Time (default) — §3.8: gap-clustered via deriveBandKey */}
          {effectiveGroupBy === 'time' && timeBandGroups.map((band) => (
            <div key={band.label}>
              <GroupSection
                title={band.label}
                taskCount={band.items.length}
              />
              {band.items.map((task) => renderTaskWithChildren(task, childrenByParentId, expandedParents, toggleParent, false))}
            </div>
          ))}

          {/* Grouped by Mission — GroupSection sticky headers, always expanded */}
          {effectiveGroupBy === 'mission' && missionGroups.map((group) => {
            const groupId = group.id || '__no_mission__';
            const isNoMission = group.id === null;
            const groupTaskIds = new Set(group.tasks.map(t => t.id));
            const { counts, failedCount } = computeStageCounts(group.tasks);

            return (
              <div key={groupId}>
                <GroupSection
                  title={group.title}
                  missionId={isNoMission ? null : group.id}
                  stageCounts={isNoMission ? null : counts}
                  failedCount={failedCount}
                  taskCount={group.tasks.length}
                />
                {group.tasks.map((task) =>
                  renderTaskWithChildren(task, childrenByParentId, expandedParents, toggleParent, false, !isNoMission, groupTaskIds)
                )}
              </div>
            );
          })}

          {/* Grouped by Status */}
          {effectiveGroupBy === 'status' && statusGroups.map((group) => (
            <div key={`status_${group.label}`}>
              <GroupSection title={group.label} taskCount={group.tasks.length} />
              {group.tasks.map((task) => renderTaskWithChildren(task, childrenByParentId, expandedParents, toggleParent, false))}
            </div>
          ))}

          {/* Grouped by Workspace */}
          {effectiveGroupBy === 'workspace' && workspaceGroups.map((group) => (
            <div key={`ws_${group.id}`}>
              <GroupSection title={group.title} taskCount={group.tasks.length} />
              {group.tasks.map((task) => renderTaskWithChildren(task, childrenByParentId, expandedParents, toggleParent, false))}
            </div>
          ))}

          {/* Flat list (no grouping) */}
          {effectiveGroupBy === 'none' && flatSorted.map((task) => renderTaskWithChildren(task, childrenByParentId, expandedParents, toggleParent, !!missionFilter))}

          {/* Empty filtered state */}
          {filtered.length === 0 && visibleTasks.length > 0 && (
            <div className="text-center py-12">
              <p className="text-text-muted text-sm">No tasks match this filter.</p>
            </div>
          )}
        </div>
      </div>
    </div>
    </SwipeProvider>
  );
}
