'use client';

import { derivePrDisplayState } from '@/lib/pr-presentation';
import { deliveryReading, type DeliveryDisplay, type DeliveryTone } from '@/lib/workflow/delivery-display';
import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import InteractiveSessions from './InteractiveSessions';
import type { LocalSessionView } from '@/lib/local-session-view';
import { NewWorkLink } from '@/components/chat/ChatEntry';
import { useRouter } from 'next/navigation';
import LocalTime from './LocalTime';
import { TaskCard } from '@/components/TaskCard';
import { GroupSection } from '@/components/GroupSection';
import { SwipeableRow, SwipeProvider, taskSwipeCardType, type SwipeCardType } from '@/components/SwipeableRow';
import { deriveDayBands } from '@/lib/condensed-timeline';
import type { ChainPositionResult } from '@/lib/task-presentation';
import type { LoopState } from '@buildd/shared';
import type { TaskType } from '@buildd/core/mission-helpers';
import type { StageCounts } from '@/components/MissionProgressBar';

export interface GridTask {
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
  /** The kernel's reading when this task owns a kernel-owned delivery (§17.5); null = legacy. */
  delivery?: DeliveryDisplay | null;
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
  mismatchCount?: number;
  taskType?: TaskType | null;
  taskClass?: string | null;
  parentTaskId?: string | null;
  loopExitConditionType?: string | null;
  /** Subject-liveness claim gate excludes this task — see isSubjectDead(). */
  subjectDead?: boolean;
  /**
   * Parent mission is `budget_exhausted`, so the claim loop skips this task —
   * see checkMissionBudgetExhausted(). Derived in page.tsx, which must select
   * `missions.status` for it: an unselected column reads as undefined and the
   * row silently renders as a healthy QUEUED task again.
   */
  missionBudgetExhausted?: boolean;
}

/**
 * The PR-provenance props handed to `TaskCard`. Extracted so the handoff is
 * testable: `TaskCard` re-derives its own stage via `deriveStage()`, which reads
 * `prLifecycleStatus`. Dropping that field here made a merged task render an
 * `OPEN #123` chip while `deriveGridTaskStage()` (and therefore the group
 * histogram) counted the same row as `DONE`. These three fields must travel
 * together — the card's stage and the histogram's stage read the same input.
 */
export function gridTaskPrProps(task: GridTask): {
  prUrl: string | null;
  prNumber: number | null;
  prLifecycleStatus: string | null;
  delivery: DeliveryDisplay | null;
} {
  return {
    prUrl: task.prUrl,
    prNumber: task.prNumber,
    prLifecycleStatus: task.prLifecycleStatus ?? null,
    delivery: task.delivery ?? null,
  };
}

/** Card type for a row's ⋯ menu — the rule shared with the mission timeline. */
export function deriveSwipeCardType(task: GridTask): SwipeCardType {
  return taskSwipeCardType(task.status, task.chain?.blockedBy?.length ?? 0);
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
      taskStatus={task.status}
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
        loopExitConditionType={task.loopExitConditionType}
        workerStartedAt={task.workerStartedAt}
        workerUpdatedAt={task.workerUpdatedAt}
        attemptCurrent={task.attemptCurrent}
        attemptTotal={task.attemptTotal}
        mismatchCount={task.mismatchCount}
        runnerName={task.runnerName}
        {...gridTaskPrProps(task)}
        taskType={task.taskType}
        subjectDead={task.subjectDead}
        missionBudgetExhausted={task.missionBudgetExhausted}
        density="row"
        groupScoped={groupScoped}
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
  // Derive attempt label from children's taskType so 'Retry', 'Review', etc. render
  // instead of the generic 'attempt'. Mixed-type children fall back to 'attempt'.
  const childTypes = new Set(children.map(c => c.taskType).filter(Boolean));
  const hasReview = childTypes.has('review') || childTypes.has('review-retry');
  const hasRetry = childTypes.has('retry');
  const childLabel = hasReview && !hasRetry
    ? (children.length === 1 ? 'review' : 'reviews')
    : hasRetry && !hasReview
      ? (children.length === 1 ? 'retry' : 'retries')
      : (children.length === 1 ? 'attempt' : 'attempts');

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

/** The histogram's bucket per canonical delivery tone (`deliveryReading`): only FAILED is failed. */
const GRID_BUCKET_FOR_DELIVERY_TONE: Record<DeliveryTone, keyof StageCounts> = {
  needs: 'REVIEW', live: 'REVIEW', stalled: 'BLOCKED', landed: 'DONE', closed: 'DONE', failed: 'FAILED',
};

/**
 * Histogram bucket for a row, or `null` for a row that belongs in no bucket.
 * Cancelled work is deliberately stopped: counting it as QUEUED (the old
 * fall-through) made stalled missions look busy.
 */
export function deriveGridTaskStage(task: GridTask): keyof StageCounts | null {
  if (task.status === 'cancelled') return null;
  // A kernel-owned delivery buckets by its own stage, the one the card's chip
  // shows (§17.5), never by the fact-cache columns.
  const workerLive = task.workerStatus === 'running' || task.workerStatus === 'starting' ||
    task.workerStatus === 'idle' || task.workerStatus === 'waiting_input';
  const kernel = task.delivery && !workerLive ? deliveryReading(task.delivery) : null;
  if (kernel) return GRID_BUCKET_FOR_DELIVERY_TONE[kernel.tone];
  if (task.status === 'failed') return 'FAILED';
  if (workerLive) return 'RUNNING';
  if (task.status === 'completed') {
    const merged = derivePrDisplayState(task.prLifecycleStatus, null) === 'merged';
    if (task.prUrl && !merged) return 'REVIEW';
    return 'DONE';
  }
  if (task.status === 'pending' || task.status === 'assigned') {
    // A subject-dead task can never be claimed — it belongs in BLOCKED, never
    // in the QUEUED count (the stage bar has no narrower bucket for it).
    if (task.subjectDead) return 'BLOCKED';
    // Same for a task whose mission is out of budget: nothing will claim it
    // until a human raises the budget, so it must not inflate QUEUED.
    if (task.missionBudgetExhausted) return 'BLOCKED';
    if ((task.chain?.blockedBy?.length ?? 0) > 0) return 'BLOCKED';
    return 'QUEUED';
  }
  return 'QUEUED';
}

export function computeStageCounts(tasks: GridTask[]): { counts: StageCounts; failedCount: number } {
  const counts: StageCounts = { BLOCKED: 0, QUEUED: 0, RUNNING: 0, REVIEW: 0, DONE: 0, FAILED: 0 };
  for (const t of tasks) {
    const stage = deriveGridTaskStage(t);
    if (stage) counts[stage]++;
  }
  const failedCount = counts.FAILED;
  // FAILED doesn't go in the bar segments
  counts.FAILED = 0;
  return { counts, failedCount };
}

/**
 * The mobile "Running now" strip: the five most recently updated tasks that
 * actually have a live worker. Uses the same RUNNING rule as the stage bar so
 * queued, blocked and budget-stalled tasks never show as running.
 */
export function selectMobileRunningTasks(tasks: GridTask[]): GridTask[] {
  return tasks
    .filter(t => deriveGridTaskStage(t) === 'RUNNING')
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 5);
}

/** Rows a band drill-down renders before asking — a band can hold hundreds. */
export const BAND_ROW_PAGE = 50;

/**
 * Keep the first `limit` rows across `groups` in order: a group cut mid-way
 * keeps its head, groups past the cap are dropped.
 */
export function capGroupedRows<G extends { [P in K]: readonly unknown[] }, K extends string = 'items'>(groups: G[], limit: number, key: K = 'items' as K): G[] {
  if (!Number.isFinite(limit)) return groups;
  const out: G[] = [];
  let left = limit;
  for (const g of groups) {
    if (left <= 0) break;
    const rows = g[key];
    out.push(rows.length <= left ? g : { ...g, [key]: rows.slice(0, left) });
    left -= rows.length;
  }
  return out;
}

interface StatusGroup {
  label: string;
  tasks: GridTask[];
}

interface TaskGridProps {
  bandFilterLabel?: string;
  tasks: GridTask[];
  missionFilter?: string | null;
  missionTitle?: string | null;
  workspaces?: { id: string; name: string }[];
  selectedWorkspaceId?: string | null;
  initiativeFilter?: string | null;
  initiativeTitle?: string | null;
  initiativeMissionIds?: string[];
  /** Local interactive sessions (presence). Never counted as agents. */
  localSessions?: LocalSessionView[];
}

/**
 * Split tasks: roots are 'work' tasks (genuine deliverables), children are
 * 'attempt' tasks (CI retries, reviewer runs) that nest under their parent work
 * task. An attempt whose parent is not a visible work task is a root itself —
 * a review or CI fix on an adopted PR hangs off a bookkeeping placeholder that
 * is never listed, and would otherwise vanish with it.
 */
export function splitTaskRoots(tasks: GridTask[]): { rootTasks: GridTask[]; childrenByParentId: Map<string, GridTask[]> } {
  const workIds = new Set(tasks.filter(t => t.taskClass === 'work').map(t => t.id));
  const rootTasks: GridTask[] = [];
  const childrenByParentId = new Map<string, GridTask[]>();
  for (const t of tasks) {
    if (t.taskClass === 'attempt' && t.parentTaskId && workIds.has(t.parentTaskId)) {
      childrenByParentId.set(t.parentTaskId, [...(childrenByParentId.get(t.parentTaskId) ?? []), t]);
    } else if (t.taskClass === 'work' || t.taskClass === 'attempt') {
      rootTasks.push(t);
    }
  }
  return { rootTasks, childrenByParentId };
}

export default function TaskGrid({ bandFilterLabel, tasks, missionFilter, missionTitle, workspaces, selectedWorkspaceId, initiativeFilter, initiativeTitle, initiativeMissionIds, localSessions = [] }: TaskGridProps) {
  const router = useRouter();

  const visibleTasks = useMemo(() => {
    if (missionFilter) return tasks.filter(t => t.missionId === missionFilter);
    if (initiativeMissionIds && initiativeMissionIds.length > 0) {
      return tasks.filter(t => t.missionId !== null && initiativeMissionIds.includes(t.missionId));
    }
    return tasks;
  }, [tasks, missionFilter, initiativeMissionIds]);

  const { rootTasks, childrenByParentId } = useMemo(() => splitTaskRoots(visibleTasks), [visibleTasks]);

  const [filter, setFilter] = useState<FilterStatus>('all');
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  const [contentFilter, setContentFilter] = useState<ContentFilter>('all');
  // Default grouping is time-band; mission is a user-selectable lens
  const [groupLens, setGroupLens] = useState<'time' | 'mission'>('time');
  const groupBy: GroupBy = missionFilter ? 'none' : groupLens;
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  // Band drill-downs page their rows; any other list renders everything.
  const [bandRowLimit, setBandRowLimit] = useState(BAND_ROW_PAGE);
  useEffect(() => setBandRowLimit(BAND_ROW_PAGE), [filter, contentFilter, search, groupLens]);
  const rowCap = bandFilterLabel ? bandRowLimit : Infinity;
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
    if (missionFilter || bandFilterLabel) return; // scoped lists start at All
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
    if (missionFilter || bandFilterLabel) return;
    try {
      const stored = JSON.parse(localStorage.getItem('buildd-activity-prefs') || '{}');
      localStorage.setItem('buildd-activity-prefs', JSON.stringify({ ...stored, filter: f }));
    } catch {}
  }, [missionFilter, bandFilterLabel]);

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

  // ─── Time-band groups — one band per calendar day (wave banding stays on
  // the mission timeline; here it split a single day into "Today" + "Today (2)") ──

  const timeBandGroups = useMemo(() => {
    if (effectiveGroupBy !== 'time') return [];
    const withTs = nonWaitingTasks.map(t => ({
      ...t,
      completionTs: new Date(t.updatedAt).getTime(),
    }));
    return deriveDayBands(withTs, new Date());
  }, [nonWaitingTasks, effectiveGroupBy]);

  // Mobile "Running now" strip: top 5 root tasks with a live worker, always visible regardless of filter
  const mobileRecentTasks = useMemo(() => {
    if (missionFilter) return [];
    return selectMobileRunningTasks(rootTasks);
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

  // Spend the row cap top-down: pinned Needs Input first, then the list.
  const shownNeedsInput = Number.isFinite(rowCap) ? needsInputTasks.slice(0, rowCap) : needsInputTasks;
  const listCap = rowCap - shownNeedsInput.length;
  const shownTimeBands = capGroupedRows(timeBandGroups, listCap);
  const shownMissionGroups = capGroupedRows(missionGroups, listCap, 'tasks');
  const shownFlat = Number.isFinite(listCap) ? flatSorted.slice(0, Math.max(0, listCap)) : flatSorted;
  const hiddenRows = Math.max(0, filtered.length - rowCap);

  // A band drill-down that selected nothing is a filtered-empty result, not an
  // empty workspace: say so, and make leaving the filter the primary action.
  if (rootTasks.length === 0 && !missionFilter && bandFilterLabel) {
    return (
      <div data-testid="task-band-empty" className="h-full flex flex-col p-8 pt-20 md:pt-8">
        <h1 className="text-[28px] font-bold text-text-primary" style={{ fontFamily: 'var(--font-display, inherit)' }}>Activity</h1>
        <div className="flex-1 flex items-center justify-center">
          <div className="max-w-md text-center">
            <div className="w-16 h-16 mx-auto bg-surface-3 rounded-full flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 4h18l-7 8v6l-4 2v-8L3 4z" />
              </svg>
            </div>
            <p className="text-meta text-text-secondary mb-2">{bandFilterLabel}</p>
            <h2 className="text-xl font-semibold text-text-primary mb-2">No tasks in this band</h2>
            <p className="text-[13px] text-text-secondary mb-4">No tasks were in this band for the selected window.</p>
            <Link
              href="/app/tasks"
              data-testid="task-band-empty-clear"
              className="inline-flex items-center min-h-11 md:min-h-0 px-4 py-2 bg-primary text-white rounded-md hover:bg-primary-hover"
            >
              Clear band filter
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (rootTasks.length === 0 && !missionFilter) {
    return (
      <div className="h-full flex flex-col pt-20 md:pt-8">
      <InteractiveSessions sessions={localSessions} />
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="w-16 h-16 mx-auto bg-surface-3 rounded-full flex items-center justify-center mb-4">
            <svg className="w-8 h-8 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-text-primary mb-4">No activity</h2>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <NewWorkLink
              kind="mission"
              className="inline-flex items-center min-h-11 md:min-h-0 px-4 py-2 bg-primary text-white rounded-md hover:bg-primary-hover"
            >
              <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              New Mission
            </NewWorkLink>
            <NewWorkLink
              kind="task"
              testId="activity-empty-new-task"
              className="inline-flex items-center min-h-11 md:min-h-0 px-4 py-2 border border-border-default text-text-primary rounded-md hover:bg-surface-3"
            >
              New task
            </NewWorkLink>
          </div>
        </div>
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
        <BandFilterLabel label={bandFilterLabel} total={allCount} />
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
            <h1 className="hidden md:block text-[28px] font-bold text-text-primary shrink-0" style={{ fontFamily: 'var(--font-display, inherit)' }}>
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
        </div>

        {!missionFilter && !bandFilterLabel && <InteractiveSessions sessions={localSessions} />}

        {/* Mobile filter UI: single scrollable chip row + optional search */}
        <div className="sm:hidden">
          {/* Combined scrollable chip row — type chips | status chips | search toggle */}
          {!missionFilter && (
            <div className="flex items-center gap-2 mb-2">
              {/* Chips scroll area — wrapper pattern ensures right-side padding isn't clipped */}
              {/* Right-edge fade says "more chips this way"; pr-8 lets the last
                  chip scroll clear of it. py-[9px] gives the chips' ::after
                  hit areas room inside the scroller's clip. */}
              <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1 [mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)]">
                <div className="flex items-center gap-1.5 pl-4 pr-8 py-[9px] min-w-max">
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
                      className={`relative shrink-0 px-2.5 py-1 text-[12px] font-medium rounded-full transition-colors whitespace-nowrap after:absolute after:inset-x-0 after:-inset-y-[9px] after:content-[''] ${
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
                    className={`relative shrink-0 px-2.5 py-1 text-[12px] font-medium rounded-full transition-colors whitespace-nowrap after:absolute after:inset-x-0 after:-inset-y-[9px] after:content-[''] ${
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
                      className={`relative shrink-0 px-2.5 py-1 text-[12px] font-medium rounded-full transition-colors whitespace-nowrap after:absolute after:inset-x-0 after:-inset-y-[9px] after:content-[''] ${
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
                className={`shrink-0 mr-2 w-11 h-11 flex items-center justify-center rounded-md transition-colors ${
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
                placeholder="Search tasks…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full px-3 py-2 text-base rounded-md border border-border-strong bg-transparent text-text-primary placeholder:text-text-muted focus:outline-none focus:border-text-secondary"
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
              placeholder="Search tasks…"
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
                {shownNeedsInput.map((task) => renderTaskWithChildren(task, childrenByParentId, expandedParents, toggleParent, !!missionFilter))}
              </div>
            </div>
          )}

          {/* Grouped by Time (default) — one section per calendar day */}
          {effectiveGroupBy === 'time' && shownTimeBands.map((band) => (
            <div key={band.label}>
              <GroupSection
                belowMobileHeader
                title={band.label}
                taskCount={band.items.length}
              />
              {band.items.map((task) => renderTaskWithChildren(task, childrenByParentId, expandedParents, toggleParent, false))}
            </div>
          ))}

          {/* Grouped by Mission — GroupSection sticky headers, always expanded */}
          {effectiveGroupBy === 'mission' && shownMissionGroups.map((group) => {
            const groupId = group.id || '__no_mission__';
            const isNoMission = group.id === null;
            const groupTaskIds = new Set(group.tasks.map(t => t.id));
            const { counts, failedCount } = computeStageCounts(group.tasks);

            return (
              <div key={groupId}>
                <GroupSection
                  belowMobileHeader
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
              <GroupSection belowMobileHeader title={group.label} taskCount={group.tasks.length} />
              {group.tasks.map((task) => renderTaskWithChildren(task, childrenByParentId, expandedParents, toggleParent, false))}
            </div>
          ))}

          {/* Grouped by Workspace */}
          {effectiveGroupBy === 'workspace' && workspaceGroups.map((group) => (
            <div key={`ws_${group.id}`}>
              <GroupSection belowMobileHeader title={group.title} taskCount={group.tasks.length} />
              {group.tasks.map((task) => renderTaskWithChildren(task, childrenByParentId, expandedParents, toggleParent, false))}
            </div>
          ))}

          {/* Flat list (no grouping) */}
          {effectiveGroupBy === 'none' && shownFlat.map((task) => renderTaskWithChildren(task, childrenByParentId, expandedParents, toggleParent, !!missionFilter))}

          {hiddenRows > 0 && (
            <div data-testid="task-band-more" className="flex flex-wrap items-center justify-center gap-3 px-4 py-4 border-t border-border-default text-meta text-text-secondary">
              <span>{`Showing ${filtered.length - hiddenRows} of ${filtered.length}`}</span>
              <button
                type="button"
                data-testid="task-band-show-more"
                onClick={() => setBandRowLimit(n => n + BAND_ROW_PAGE)}
                className="min-h-[44px] px-4 rounded-md border border-border-default text-text-primary hover:bg-surface-2"
              >
                {`Show ${Math.min(BAND_ROW_PAGE, hiddenRows)} more`}
              </button>
            </div>
          )}

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

function BandFilterLabel({ label, total }: { label?: string; total: number }) {
  if (!label) return null;
  return <div data-testid="task-band-filter" className="px-4 mb-3 flex flex-wrap items-center gap-3 text-meta text-text-secondary"><span>{label}</span><span data-testid="task-band-total" className="text-text-primary">{`${total} ${total === 1 ? 'task' : 'tasks'}`}</span><Link className="min-h-[44px] inline-flex items-center text-accent-text" href="/app/tasks">Clear band filter</Link></div>;
}
