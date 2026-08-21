import { LIVE_WORKER_STATUSES, isGateSatisfied } from '@/lib/task-presentation';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CondensedTaskWorker = {
  id: string;
  status: string;
  prUrl: string | null;
  prNumber: number | null;
  prLifecycleStatus: string | null;
  mergedAt: string | null;
  completedAt: string | null;
  startedAt: string | null;
  currentAction: string | null;
  branch: string | null;
  waitingFor: { type: string; prompt: string; options?: string[] } | null;
};

export type CondensedTask = {
  id: string;
  status: string;
  dependsOn: string[] | null;
  workers: CondensedTaskWorker[];
  /**
   * Precomputed by the caller: is there a live action the human must take?
   * Under agent-review policy: true only when reviewer_approved or reviewer_escalated.
   * Under other policies: always true (any open PR awaits human merge).
   * Undefined = backward-compat default (treated as true).
   */
  humanActionPending?: boolean;
};

export type TimelineGroups<T extends CondensedTask = CondensedTask> = {
  /** Completed tasks with an open (non-merged, non-closed) PR. */
  waitingOnYou: T[];
  /** Tasks with a live worker (running / starting / idle / waiting_input). */
  running: T[];
  /** Pending tasks with all dependencies gate-satisfied — ready to claim. */
  nextQueued: T[];
  /** Pending tasks with at least one unsatisfied dependency. */
  blocked: T[];
  /** Completed tasks with a merged PR (or no PR produced). */
  done: T[];
  /** Failed tasks. */
  failed: T[];
};

// ─── Predicates ───────────────────────────────────────────────────────────────

function hasLiveWorker(task: CondensedTask): boolean {
  const latest = task.workers[0];
  if (!latest) return false;
  return (LIVE_WORKER_STATUSES as readonly string[]).includes(latest.status);
}

function isWaitingOnYou(task: CondensedTask): boolean {
  if (task.status !== 'completed') return false;
  const latest = task.workers[0];
  if (!latest?.prUrl) return false;
  // Terminal PR states — never waiting regardless of DB staleness
  if (latest.mergedAt) return false;
  if (latest.prLifecycleStatus === 'closed') return false;
  if (latest.prLifecycleStatus === 'merged') return false;
  // Only wait when there is a live human action (explicit false = not a human action)
  if (task.humanActionPending === false) return false;
  return true;
}

function allDepsGateSatisfied(task: CondensedTask, taskMap: Map<string, CondensedTask>): boolean {
  const deps = task.dependsOn ?? [];
  if (deps.length === 0) return true;
  for (const depId of deps) {
    const dep = taskMap.get(depId);
    if (!dep) continue; // Unknown dep — can't block on a task not in this mission
    if (!isGateSatisfied(dep, dep.workers)) return false;
  }
  return true;
}

// ─── Grouping function ────────────────────────────────────────────────────────

/**
 * Partition timeline tasks into the condensed-timeline hierarchy defined in
 * docs/design/mobile-decision-flow.md §3.1.
 *
 * Priority order (first match wins):
 *   1. Has live worker → running
 *   2. completed + open PR → waitingOnYou
 *   3. completed + merged PR / no PR → done
 *   4. failed → failed
 *   5. pending/assigned + all deps gate-satisfied → nextQueued
 *   6. pending/assigned + unresolved dep → blocked
 *
 * Generic so it works with enriched supertypes without losing type information.
 */
export function groupTimelineTasks<T extends CondensedTask>(
  tasks: T[],
  taskMap: Map<string, CondensedTask>,
): TimelineGroups<T> {
  const groups: TimelineGroups<T> = {
    waitingOnYou: [],
    running: [],
    nextQueued: [],
    blocked: [],
    done: [],
    failed: [],
  };

  for (const task of tasks) {
    if (hasLiveWorker(task)) {
      groups.running.push(task);
      continue;
    }

    if (task.status === 'completed') {
      if (isWaitingOnYou(task)) {
        groups.waitingOnYou.push(task);
      } else {
        groups.done.push(task);
      }
      continue;
    }

    if (task.status === 'failed') {
      groups.failed.push(task);
      continue;
    }

    if (task.status === 'pending' || task.status === 'assigned') {
      if (allDepsGateSatisfied(task, taskMap)) {
        groups.nextQueued.push(task);
      } else {
        groups.blocked.push(task);
      }
      continue;
    }
  }

  return groups;
}

// ─── Chain identification ─────────────────────────────────────────────────────

export type ChainShape = 'linear' | 'fan-out' | 'fan-in' | 'standalone';

/**
 * A structurally-identified chain unit.
 * - linear: sequential tasks where each has exactly 1 unresolved blocker with 1 unresolved dependent
 * - fan-out: head with N > 1 unresolved dependents (tail = the siblings)
 * - fan-in: task with N > 1 unresolved blockers (tail is empty; standalone row)
 * - standalone: no unresolved deps or dependents in the task set
 */
export type ChainUnit<T = CondensedTask> = {
  head: T;
  /** For linear: ordered tail members. For fan-out: the dependent siblings. For fan-in/standalone: empty. */
  tail: T[];
  shape: ChainShape;
};

/** Same bucket shape as TimelineGroups but each bucket holds ChainUnit arrays. */
export type TimelineGroupsOfChains<T extends CondensedTask = CondensedTask> = {
  waitingOnYou: ChainUnit<T>[];
  running: ChainUnit<T>[];
  nextQueued: ChainUnit<T>[];
  blocked: ChainUnit<T>[];
  done: ChainUnit<T>[];
  failed: ChainUnit<T>[];
};

/**
 * Identify chains from a task set.
 *
 * A linear chain is a maximal path where every node has exactly one unresolved
 * blocker in the task set AND that blocker has exactly one unresolved dependent.
 * Nodes that violate either condition are junction nodes.
 *
 * "Unresolved" = dep gate not satisfied (isGateSatisfied returns false).
 * Only blockers present in taskMap are considered.
 *
 * Algorithm is O(N) with the adjacency index built in the first pass.
 */
export function identifyChains<T extends CondensedTask>(
  tasks: T[],
  taskMap: Map<string, CondensedTask>,
): ChainUnit<T>[] {
  const taskById = new Map(tasks.map(t => [t.id, t]));
  const taskIds = new Set(tasks.map(t => t.id));

  // Pass 1: build unresolved adjacency (only within our task set)
  const unresolvedBlockers = new Map<string, string[]>(); // id → blocker ids
  const unresolvedDependents = new Map<string, string[]>(); // id → dependent ids
  for (const task of tasks) {
    unresolvedBlockers.set(task.id, []);
    unresolvedDependents.set(task.id, []);
  }
  for (const task of tasks) {
    for (const depId of task.dependsOn ?? []) {
      if (!taskIds.has(depId)) continue; // not in set → treated as resolved
      const dep = taskMap.get(depId);
      if (!dep) continue;
      if (!isGateSatisfied(dep, dep.workers)) {
        unresolvedBlockers.get(task.id)!.push(depId);
        unresolvedDependents.get(depId)!.push(task.id);
      }
    }
  }

  // Pass 2: determine interior nodes of a linear chain.
  // Interior: exactly 1 unresolved blocker, AND that blocker has exactly 1 unresolved dependent (itself).
  function isLinearInterior(id: string): boolean {
    const bl = unresolvedBlockers.get(id) ?? [];
    if (bl.length !== 1) return false;
    return (unresolvedDependents.get(bl[0]) ?? []).length === 1;
  }

  // Pass 3: walk chains starting from non-interior heads
  const visited = new Set<string>();
  const chains: ChainUnit<T>[] = [];

  for (const task of tasks) {
    if (visited.has(task.id)) continue;
    if (isLinearInterior(task.id)) continue; // will be reached from its head

    visited.add(task.id);
    const myBlockers = unresolvedBlockers.get(task.id) ?? [];
    const myDeps = unresolvedDependents.get(task.id) ?? [];

    if (myBlockers.length > 1) {
      // Fan-in: standalone row, no rail
      chains.push({ head: task, tail: [], shape: 'fan-in' });
    } else if (myDeps.length > 1) {
      // Fan-out: collect all unvisited dependents as siblings
      const tail: T[] = [];
      for (const depId of myDeps) {
        if (!visited.has(depId)) {
          const dep = taskById.get(depId);
          if (dep) { visited.add(depId); tail.push(dep); }
        }
      }
      chains.push({ head: task, tail, shape: 'fan-out' });
    } else if (myDeps.length === 1) {
      // Linear: walk the chain forward, cycle-safe
      const tail: T[] = [];
      const pathSeen = new Set<string>([task.id]);
      let current = task;

      for (;;) {
        const deps = unresolvedDependents.get(current.id) ?? [];
        if (deps.length !== 1) break;
        const nextId = deps[0];
        if (pathSeen.has(nextId)) break; // cycle guard
        const nextBlockers = unresolvedBlockers.get(nextId) ?? [];
        if (nextBlockers.length !== 1) break; // fan-in ahead — stop
        const next = taskById.get(nextId);
        if (!next || visited.has(nextId)) break;
        visited.add(nextId);
        pathSeen.add(nextId);
        tail.push(next);
        current = next;
      }
      chains.push({ head: task, tail, shape: tail.length > 0 ? 'linear' : 'standalone' });
    } else {
      chains.push({ head: task, tail: [], shape: 'standalone' });
    }
  }

  // Defensive: collect any unvisited tasks (cycle-related or edge cases)
  for (const task of tasks) {
    if (!visited.has(task.id)) {
      chains.push({ head: task, tail: [], shape: 'standalone' });
    }
  }

  return chains;
}

/**
 * Partition timeline tasks into sections based on the HEAD's readiness.
 *
 * Runs identifyChains() first, then assigns each ChainUnit to a section
 * using the same predicates as groupTimelineTasks(). The entire chain
 * follows the head — this prevents chain-severing (e.g. A in waitingOnYou
 * and B in blocked when A→B is a linear chain).
 */
export function groupChainUnits<T extends CondensedTask>(
  tasks: T[],
  taskMap: Map<string, CondensedTask>,
): TimelineGroupsOfChains<T> {
  const groups: TimelineGroupsOfChains<T> = {
    waitingOnYou: [],
    running: [],
    nextQueued: [],
    blocked: [],
    done: [],
    failed: [],
  };

  for (const chain of identifyChains(tasks, taskMap)) {
    const { head } = chain;
    if (hasLiveWorker(head)) {
      groups.running.push(chain);
    } else if (head.status === 'completed') {
      if (isWaitingOnYou(head)) {
        groups.waitingOnYou.push(chain);
      } else {
        groups.done.push(chain);
      }
    } else if (head.status === 'failed') {
      groups.failed.push(chain);
    } else if (head.status === 'pending' || head.status === 'assigned') {
      if (allDepsGateSatisfied(head, taskMap)) {
        groups.nextQueued.push(chain);
      } else {
        groups.blocked.push(chain);
      }
    }
  }

  return groups;
}

// ─── Gate chip helpers — I-11 ─────────────────────────────────────────────────

/** True when the awaiting-merge gate chip should be collapsed (PR has been merged). */
export function gateChipCollapsed(mergedAt: string | null | undefined): boolean {
  return !!mergedAt;
}

// ─── Wave banding — §3.8 ─────────────────────────────────────────────────────

export type BandedGroup<T> = {
  label: string;
  items: T[];
};

/** Derive a human-readable time-band label for a UTC timestamp relative to now. */
export function deriveBandLabel(ts: number, now: Date): string {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);

  if (ts >= todayStart.getTime()) return 'Today';
  if (ts >= yesterdayStart.getTime()) return 'Yesterday';
  if (ts >= weekStart.getTime()) return new Date(ts).toLocaleDateString('en-US', { weekday: 'long' });

  const yearStart = new Date(now.getFullYear(), 0, 1).getTime();
  if (ts >= yearStart) return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Gap-cluster items by completionTs into wave bands for §3.8.
 *
 * Items are sorted ascending by completionTs; any gap ≥ 4 h opens a new band.
 * The band label derives from the first item's timestamp relative to now.
 * Duplicate labels (e.g. two "Yesterday" bands) get ordinal suffixes.
 * Bands are returned newest-first for display.
 */
export function deriveBandKey<T extends { id: string; completionTs: number }>(
  items: T[],
  now: Date,
): BandedGroup<T>[] {
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) => a.completionTs - b.completionTs);
  const GAP_MS = 4 * 60 * 60 * 1000;

  const rawBands: Array<{ firstTs: number; items: T[] }> = [];
  let currentBand: { firstTs: number; items: T[] } | null = null;
  let prevTs = 0;

  for (const item of sorted) {
    if (!currentBand || item.completionTs - prevTs >= GAP_MS) {
      currentBand = { firstTs: item.completionTs, items: [] };
      rawBands.push(currentBand);
    }
    currentBand.items.push(item);
    prevTs = item.completionTs;
  }

  // Assign labels, appending ordinals for duplicate label strings
  const labelCounts = new Map<string, number>();
  const labeled = rawBands.map(band => {
    const base = deriveBandLabel(band.firstTs, now);
    const seen = labelCounts.get(base) ?? 0;
    labelCounts.set(base, seen + 1);
    const label = seen === 0 ? base : `${base} (${seen + 1})`;
    return { label, items: [...band.items].reverse() };
  });

  // Return newest band first
  return labeled.reverse();
}
