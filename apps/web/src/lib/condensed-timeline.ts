import { LIVE_WORKER_STATUSES, isGateSatisfied } from '@/lib/task-presentation';
import type { SegmentState } from '@/lib/task-presentation';
import { shouldSerializeByManifest } from '@buildd/core/path-overlap';

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
  /** Supersession edge (task fcaf83d5) — set only on a closed, unmerged PR. */
  supersededByPrNumber?: number | null;
  supersededByPrUrl?: string | null;
  supersededReason?: string | null;
};

export type CondensedTask = {
  id: string;
  status: string;
  dependsOn: string[] | null;
  workers: CondensedTaskWorker[];
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

/**
 * A `completed` task's terminal state is its PR's state, not the task's
 * (task facae217) — an open, conflicted, or CI-failing PR always routes here,
 * regardless of merge-policy tier or reviewer verdict. Never bury an unmerged
 * PR in the done pile: a reviewer's "changes requested" with a retry queued
 * still means the work is not finished, whether or not the retry has started.
 */
function isWaitingOnYou(task: CondensedTask): boolean {
  if (task.status !== 'completed') return false;
  const latest = task.workers[0];
  if (!latest?.prUrl) return false;
  // Terminal PR states — never waiting regardless of DB staleness
  if (latest.mergedAt) return false;
  if (latest.prLifecycleStatus === 'closed') return false;
  if (latest.prLifecycleStatus === 'merged') return false;
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

  return collapseTerminalChains(chains);
}

// ─── Terminal chain collapse — timeline-mobile-rail.md D1 ────────────────────

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

/**
 * Second adjacency pass over tasks that have already landed (Rule D1-1).
 *
 * `identifyChains()` links two tasks only while the edge between them is
 * *unresolved*, and a terminal task's dependencies are resolved by definition —
 * so a SPEC→BUILD→REVIEW run that fully merged used to fall out as three
 * `standalone` units, one flat row each, erasing the shape the rail is supposed
 * to draw. This pass re-runs the SAME structural test over the **full**
 * `dependsOn` adjacency, restricted to the terminal units the first pass left
 * standalone. It never touches a unit the first pass already claimed, so
 * blocked/queued/running grouping is bit-for-bit unchanged.
 *
 * Retry lineage (`parentTaskId`) is deliberately not an input here: a retry is a
 * Lane-2 sibling, never an ordinal member (Rule D1-2).
 */
function collapseTerminalChains<T extends CondensedTask>(chains: ChainUnit<T>[]): ChainUnit<T>[] {
  const pool = chains.filter(c => c.shape === 'standalone' && TERMINAL_STATUSES.has(c.head.status));
  if (pool.length < 2) return chains;

  const poolIds = new Set(pool.map(c => c.head.id));
  const byId = new Map(pool.map(c => [c.head.id, c.head]));
  const blockers = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const id of poolIds) {
    blockers.set(id, []);
    dependents.set(id, []);
  }
  for (const c of pool) {
    for (const depId of c.head.dependsOn ?? []) {
      if (!poolIds.has(depId)) continue;
      blockers.get(c.head.id)!.push(depId);
      dependents.get(depId)!.push(c.head.id);
    }
  }

  /** Same shape test as `isLinearInterior`, over resolved edges. */
  const isTerminalLinearInterior = (id: string): boolean => {
    const bl = blockers.get(id) ?? [];
    if (bl.length !== 1) return false;
    return (dependents.get(bl[0]) ?? []).length === 1;
  };

  const visited = new Set<string>();
  /** taskId → id of the unit head that absorbed it. */
  const absorbedBy = new Map<string, string>();
  /** head id → the collapsed unit replacing its standalone entry. */
  const collapsed = new Map<string, ChainUnit<T>>();

  // Walk roots first. The mission page feeds tasks newest-first, so a dependent
  // would otherwise claim headship before its own blocker is ever considered and
  // the chain would never assemble (Rule D1-3 wants blocker-before-blocked).
  // Array.prototype.sort is stable, so ties keep the incoming order.
  const walkOrder = [...pool].sort(
    (a, b) => (blockers.get(a.head.id) ?? []).length - (blockers.get(b.head.id) ?? []).length,
  );

  for (const c of walkOrder) {
    const id = c.head.id;
    if (visited.has(id)) continue;
    if (isTerminalLinearInterior(id)) continue; // reached from its head instead
    visited.add(id);

    const myDeps = dependents.get(id) ?? [];

    if (myDeps.length > 1) {
      // Fan-out: the dependents become Lane-2 siblings, not ordinal members.
      const tail: T[] = [];
      for (const depId of myDeps) {
        if (visited.has(depId)) continue;
        const dep = byId.get(depId);
        if (!dep) continue;
        visited.add(depId);
        absorbedBy.set(depId, id);
        tail.push(dep);
      }
      if (tail.length > 0) collapsed.set(id, { head: c.head, tail, shape: 'fan-out' });
      continue;
    }

    // Linear: walk forward while each step stays a 1:1 edge. Cycle-safe.
    const tail: T[] = [];
    const pathSeen = new Set<string>([id]);
    let current = id;
    for (;;) {
      const deps = dependents.get(current) ?? [];
      if (deps.length !== 1) break;
      const nextId = deps[0];
      if (pathSeen.has(nextId) || visited.has(nextId)) break;
      if ((blockers.get(nextId) ?? []).length !== 1) break; // fan-in ahead — stop
      const next = byId.get(nextId);
      if (!next) break;
      visited.add(nextId);
      pathSeen.add(nextId);
      absorbedBy.set(nextId, id);
      tail.push(next);
      current = nextId;
    }
    if (tail.length > 0) collapsed.set(id, { head: c.head, tail, shape: 'linear' });
  }

  if (collapsed.size === 0) return chains;

  // Rebuild in the original order; a collapsed unit takes its head's slot and
  // its absorbed members drop out.
  const result: ChainUnit<T>[] = [];
  for (const c of chains) {
    if (absorbedBy.has(c.head.id)) continue;
    result.push(collapsed.get(c.head.id) ?? c);
  }
  return result;
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

// ─── Mobile rail model — timeline-mobile-rail.md D2–D5, D8 ───────────────────

/**
 * The task shape the rail reads. Deliberately structural rather than tied to
 * `CondensedTimelineTask`: the rail is a pure model, and keeping its input
 * minimal is what lets it be tested without a React tree.
 */
export type RailTaskLike = {
  id: string;
  status: string;
  dependsOn?: string[] | null;
  pathManifest?: string[] | null;
  taskCreatedAt: string;
  taskUpdatedAt: string;
  latestWorker: { mergedAt: string | null; prLifecycleStatus?: string | null } | null;
  /**
   * The stored mission phase (docs/specs/mission-legibility.md §1). Both NULL
   * or both set — a half-set row is a write-time bug, never a rendering
   * concern here.
   */
  missionPhaseIndex?: number | null;
  missionPhaseLabel?: string | null;
};

/** Hard = stored `dependsOn`. Soft = pathManifest ordering. None = no edge. */
export type RailEdgeClass = 'hard' | 'soft' | 'none';

export type RailSibling<T> = {
  task: T;
  /** Advisory pathManifest ordering behind a lane sibling (Rule D3-3). */
  soft: boolean;
};

export type RailNode<T> = {
  kind: 'node';
  id: string;
  /** Lane-1 representative — the chain head. */
  head: T;
  /** Ordinal members (head first, topological). Length 1 for a standalone task. */
  members: T[];
  /** `▣N` badge value. 1 means no badge (Rule D1-4). */
  count: number;
  /** Class of the rail segment entering this node from the node above it. */
  edge: RailEdgeClass;
  /** Lane-2 fan-out siblings rendered individually. */
  siblings: RailSibling<T>[];
  /** Siblings folded behind the `├╮ +N` fork glyph (Rule D2-2). */
  forkHidden: number;
  /** Those same siblings, so the fork glyph can disclose them on tap. */
  hiddenSiblings: T[];
  /** Retry lineage rendered as red stubs in Lane 2 (Rule D3-5). */
  retries: T[];
  /** Bucketing timestamp — merge/update time when landed, creation time when not. */
  ts: number;
  /** False for `pending`/`assigned` — everything below the `now` tick. */
  started: boolean;
};

export type RailTick = { kind: 'tick'; id: string; label: string; now: boolean };
export type RailLabel = { kind: 'label'; id: string; text: 'waiting on you' | 'running' };
export type RailGoal = { total: number; passed: number | null };

/**
 * A mission-phase header row (docs/specs/mission-legibility.md Rule R4-1).
 * `kind: 'phase'` is the row discriminator — it is not a work-kind, and no
 * rail row type ever carries a work-kind field (§4.4 of the spec).
 */
export type RailPhase = {
  kind: 'phase';
  id: string;
  index: number;
  label: string;
  /** One segment per member task, in rail order (Rule P1-10). */
  segments: Array<{ taskId: string; state: SegmentState }>;
  /** Count of `filled` segments only — `half` counts toward `total`, not this (Rule P1-11). */
  filled: number;
  total: number;
  /** 'complete': every member filled/skipped. 'live': lowest incomplete phase with an active member (Rule P1-12). */
  state: 'complete' | 'live' | 'upcoming';
};

export type RailRow<T> = RailNode<T> | RailTick | RailLabel | RailPhase;
export type RailModel<T> = { rows: RailRow<T>[]; goal: RailGoal | null };

export type RailGroups<T> = {
  waitingOnYou: ChainUnit<T>[];
  running: ChainUnit<T>[];
  nextQueued: ChainUnit<T>[];
  blocked: ChainUnit<T>[];
  done: ChainUnit<T>[];
  failed: ChainUnit<T>[];
};

export type RailOptions<T> = {
  /** childId → parentId, the same map the Structure view consumes (Rule D3-6). */
  retryLinks?: Map<string, string>;
  now?: Date;
  /** Mission goal criteria; `passed: null` means never evaluated (Rule D5-3). */
  goal?: RailGoal | null;
  /** Lane-2 width budget before the fork glyph takes over (Rule D2-2). */
  laneCap?: number;
};

/** Weekday + day-of-month, e.g. `Sat 12` — the tick label form (Rule D4-3). */
function railDayLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getDate()}`;
}

/** Local calendar-day key. Ticks are per calendar day, never gap-clustered. */
function railDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function railTaskTs(task: RailTaskLike): number {
  if (TERMINAL_STATUSES.has(task.status)) {
    const merged = task.latestWorker?.mergedAt;
    return new Date(merged ?? task.taskUpdatedAt).getTime();
  }
  return new Date(task.taskCreatedAt).getTime();
}

const railStarted = (task: RailTaskLike): boolean =>
  task.status !== 'pending' && task.status !== 'assigned';

/**
 * Build the mobile rail: one continuous vertical run of nodes, oldest at the
 * top, the mission's goal root at the bottom.
 *
 * The rail consumes the SAME `ChainUnit[]` the desktop sections and the
 * Structure canvas consume (Rule D2-1) — nothing about the dependency graph is
 * re-derived here. What this function adds is purely presentational: which lane
 * a task sits in, which edge class connects it upward, and where the day/`now`
 * ticks fall between nodes.
 *
 * Order is chronological, past to future, because the rail's bottom element is
 * the goal root — the thing the mission is heading towards. Day ticks therefore
 * ascend, and the `now` tick marks the crossing into work that has not started.
 */
export function buildRail<T extends RailTaskLike>(
  groups: RailGroups<T>,
  options: RailOptions<T> = {},
): RailModel<T> {
  const { retryLinks, goal, laneCap = 2 } = options;

  // Retry children are Lane-2 stubs on the node that owns their parent, so they
  // must never also surface as their own Lane-1 node.
  const retryChildren = new Map<string, T[]>();
  const retryChildIds = new Set<string>();
  if (retryLinks && retryLinks.size > 0) {
    const everyTask = new Map<string, T>();
    for (const bucket of Object.values(groups) as ChainUnit<T>[][]) {
      for (const chain of bucket) for (const t of [chain.head, ...chain.tail]) everyTask.set(t.id, t);
    }
    for (const [childId, parentId] of retryLinks) {
      const child = everyTask.get(childId);
      if (!child || !everyTask.has(parentId)) continue;
      const bucket = retryChildren.get(parentId);
      if (bucket) bucket.push(child);
      else retryChildren.set(parentId, [child]);
      retryChildIds.add(childId);
    }
  }

  const toNode = (chain: ChainUnit<T>): RailNode<T> | null => {
    if (retryChildIds.has(chain.head.id)) return null;

    const isFanOut = chain.shape === 'fan-out';
    const members = isFanOut ? [chain.head] : [chain.head, ...chain.tail];

    // A retry hangs off whichever task in the unit it re-ran — head, ordinal
    // member, or Lane-2 sibling.
    const retries = [chain.head, ...chain.tail].flatMap(m => retryChildren.get(m.id) ?? []);

    // Lane-2 budget: a retry stub is the load-bearing signal, so it always gets
    // its slot and the sibling list gives way instead (Rule D2-2).
    const room = Math.max(0, retries.length > 0 ? laneCap - 1 : laneCap);
    const rawSiblings = isFanOut ? chain.tail.filter(t => !retryChildIds.has(t.id)) : [];
    const shown = rawSiblings.slice(0, room);

    const siblings: RailSibling<T>[] = shown.map(task => ({
      task,
      soft: rawSiblings.some(other => {
        if (other.id === task.id) return false;
        // A stored edge in either direction already speaks for the ordering.
        if ((task.dependsOn ?? []).includes(other.id)) return false;
        if ((other.dependsOn ?? []).includes(task.id)) return false;
        if (!shouldSerializeByManifest(task.pathManifest, other.pathManifest)) return false;
        // Only the later-created sibling carries the dashed treatment.
        return new Date(other.taskCreatedAt).getTime() < new Date(task.taskCreatedAt).getTime();
      }),
    }));

    return {
      kind: 'node',
      id: chain.head.id,
      head: chain.head,
      members,
      count: members.length,
      edge: 'none',
      siblings,
      forkHidden: rawSiblings.length - shown.length,
      hiddenSiblings: rawSiblings.slice(room),
      retries,
      ts: Math.max(...members.map(railTaskTs)),
      started: members.some(railStarted),
    };
  };

  const sortedTerminal = [...groups.done, ...groups.failed]
    .map(toNode)
    .filter((n): n is RailNode<T> => n !== null)
    .sort((a, b) => a.ts - b.ts);

  const sectionNodes = (chains: ChainUnit<T>[]) =>
    chains.map(toNode).filter((n): n is RailNode<T> => n !== null);

  const waitingOnYou = sectionNodes(groups.waitingOnYou);
  const running = sectionNodes(groups.running);
  const upcoming = [...sectionNodes(groups.nextQueued), ...sectionNodes(groups.blocked)];

  const ordered: RailNode<T>[] = [...sortedTerminal, ...waitingOnYou, ...running, ...upcoming];
  if (ordered.length === 0) return { rows: [], goal: normaliseGoal(goal) };

  // Edge class of the segment entering each node from the one above it.
  for (let i = 1; i < ordered.length; i++) {
    const node = ordered[i];
    const prev = ordered[i - 1];
    const prevIds = new Set([...prev.members, ...prev.siblings.map(s => s.task)].map(t => t.id));
    const deps = node.head.dependsOn ?? [];
    if (deps.some(d => prevIds.has(d))) {
      node.edge = 'hard';
    } else if (shouldSerializeByManifest(node.head.pathManifest, prev.head.pathManifest)) {
      node.edge = 'soft';
    }
  }

  // ─── Mission phase headers — mission-legibility.md §4.1/§4.3 ───────────────
  //
  // Walk the SAME ordered sequence, flattening each node's ordinal members plus
  // its Lane-2 fan-out siblings (shown and fork-hidden) — every task that gets
  // its own row somewhere on the rail. Retry lineage is deliberately excluded:
  // a retry inherits its parent's phase (Rule P1-7) but is rendered as an
  // attempt annotation on the parent, not as an independent unit of progress,
  // so counting it would double a phase's own segment for one logical step.
  type PhaseAccum = {
    index: number;
    label: string;
    segments: Array<{ taskId: string; state: SegmentState }>;
    hasActiveMember: boolean;
    /** `ordered` index the header renders before. */
    atOrderedIndex: number;
  };
  const phaseSegmentState = (task: T): SegmentState => {
    if (task.status === 'cancelled') return 'skipped';
    if (task.status === 'completed') return task.latestWorker?.mergedAt ? 'filled' : 'half';
    return 'empty';
  };
  const phaseByIndex = new Map<number, PhaseAccum>();
  const phaseOpenOrder: number[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const node = ordered[i];
    const candidates = [
      ...node.members,
      ...node.siblings.map(s => s.task),
      ...node.hiddenSiblings,
    ];
    for (const member of candidates) {
      const index = member.missionPhaseIndex;
      const label = member.missionPhaseLabel;
      if (index == null || label == null) continue;
      let accum = phaseByIndex.get(index);
      if (!accum) {
        accum = { index, label, segments: [], hasActiveMember: false, atOrderedIndex: i };
        phaseByIndex.set(index, accum);
        phaseOpenOrder.push(index);
      } else if (accum.label !== label) {
        // AC-5: a divergent label for one index is a bug, surfaced loudly rather
        // than silently resolved by picking one.
        throw new Error(
          `Mission phase ${index} has divergent labels: "${accum.label}" vs "${label}" ` +
          `(docs/specs/mission-legibility.md Rule P1-2)`,
        );
      }
      accum.segments.push({ taskId: member.id, state: phaseSegmentState(member) });
      if (!['completed', 'failed', 'cancelled'].includes(member.status)) accum.hasActiveMember = true;
    }
  }

  // Rule P1-12: the live phase is the lowest incomplete index with an active
  // member. At most one phase is live; when every phase is complete, none is.
  let livePhaseIndex: number | null = null;
  for (const index of [...phaseByIndex.keys()].sort((a, b) => a - b)) {
    const accum = phaseByIndex.get(index)!;
    const complete = accum.segments.every(s => s.state === 'filled' || s.state === 'skipped');
    if (!complete && accum.hasActiveMember) { livePhaseIndex = index; break; }
  }

  const phaseRowAt = new Map<number, RailPhase>();
  for (const index of phaseOpenOrder) {
    const accum = phaseByIndex.get(index)!;
    const complete = accum.segments.every(s => s.state === 'filled' || s.state === 'skipped');
    phaseRowAt.set(accum.atOrderedIndex, {
      kind: 'phase',
      id: `phase-${index}`,
      index,
      label: accum.label,
      segments: accum.segments,
      filled: accum.segments.filter(s => s.state === 'filled').length,
      total: accum.segments.length,
      state: complete ? 'complete' : index === livePhaseIndex ? 'live' : 'upcoming',
    });
  }
  // Rule R4-8: a phase header and a day tick are both full-width separators —
  // when phases exist, day ticks are suppressed entirely and only `now` survives.
  const suppressDayTicks = phaseRowAt.size > 0;

  // Day ticks: one per calendar-day transition in the rendered sequence. No gap
  // clustering, no ordinal suffix — the defect class `deriveBandKey` carries
  // cannot exist here because there are no bands to number (Rule D4-4).
  const dayTicks = new Map<number, { key: string; label: string }>();
  let prevDayKey: string | null = null;
  for (let i = 0; i < ordered.length; i++) {
    const key = railDayKey(ordered[i].ts);
    if (key === prevDayKey) continue;
    dayTicks.set(i, { key, label: railDayLabel(ordered[i].ts) });
    prevDayKey = key;
  }

  // The `now` tick renders exactly once (Rule D4-5). When today already has a
  // day tick, that tick takes the `now ·` prefix instead of a second row
  // appearing for the same day.
  const nowMs = (options.now ?? new Date()).getTime();
  const todayKey = railDayKey(nowMs);
  let nowTickAt: number | null = null;
  for (const [index, tick] of dayTicks) {
    if (tick.key === todayKey) { nowTickAt = index; break; }
  }
  if (nowTickAt === null) {
    const firstUnstarted = ordered.findIndex(n => !n.started);
    // Nothing unstarted and nothing dated today: a trailing `now` tick would be
    // chrome with nothing beneath it unless the goal root follows.
    if (firstUnstarted !== -1) nowTickAt = firstUnstarted;
    else if (normaliseGoal(goal)) nowTickAt = ordered.length;
  }

  const labelAt = new Map<number, RailLabel>();
  if (waitingOnYou.length > 0) {
    labelAt.set(sortedTerminal.length, { kind: 'label', id: 'label-waiting', text: 'waiting on you' });
  }
  if (running.length > 0) {
    labelAt.set(sortedTerminal.length + waitingOnYou.length, {
      kind: 'label',
      id: 'label-running',
      text: 'running',
    });
  }

  const rows: RailRow<T>[] = [];
  for (let i = 0; i <= ordered.length; i++) {
    const dayTick = suppressDayTicks ? undefined : dayTicks.get(i);
    const isNow = i === nowTickAt;

    if (dayTick || isNow) {
      const dayLabel = dayTick?.label ?? railDayLabel(nowMs);
      rows.push({
        kind: 'tick',
        id: `tick-${i}`,
        label: isNow ? `now · ${dayLabel}` : dayLabel,
        now: isNow,
      });
    }

    // Rule R4-10: when the `now` boundary and a phase boundary coincide, `now`
    // renders first (pushed above) and the phase header follows — never the
    // reverse, and no day tick can join them (suppressed whenever any phase exists).
    const phaseRow = phaseRowAt.get(i);
    if (phaseRow) rows.push(phaseRow);

    const label = labelAt.get(i);
    if (label) rows.push(label);
    const node = ordered[i];
    if (node) rows.push(node);
  }

  return { rows, goal: normaliseGoal(goal) };
}

/** An absent or empty gate renders no root at all (Rule D5-4). */
function normaliseGoal(goal: RailGoal | null | undefined): RailGoal | null {
  if (!goal || goal.total <= 0) return null;
  return { total: goal.total, passed: goal.passed };
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
  if (ts >= weekStart.getTime()) {
    const d = new Date(ts);
    const date = d.getDate();
    return new Date(ts).toLocaleDateString('en-US', { weekday: 'short' }) + ` ${date}`;
  }

  const yearStart = new Date(now.getFullYear(), 0, 1).getTime();
  if (ts >= yearStart) return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Get the calendar day key in local timezone (YYYY-MM-DD). */
function getLocalDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Gap-cluster items by completionTs into wave bands for §3.8.
 *
 * Groups items by calendar day first (to prevent same-day splits), then applies
 * 4-hour gap clustering within each day. The band label derives from the first
 * item's timestamp relative to now, and includes the date to distinguish bands.
 * Bands are returned newest-first for display.
 */
export function deriveBandKey<T extends { id: string; completionTs: number }>(
  items: T[],
  now: Date,
): BandedGroup<T>[] {
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) => a.completionTs - b.completionTs);
  const GAP_MS = 4 * 60 * 60 * 1000;

  // Group by calendar day first
  const byDay = new Map<string, T[]>();
  for (const item of sorted) {
    const dayKey = getLocalDateKey(item.completionTs);
    const bucket = byDay.get(dayKey);
    if (bucket) bucket.push(item);
    else byDay.set(dayKey, [item]);
  }

  // Within each day, apply gap clustering
  const allBands: Array<{ firstTs: number; items: T[] }> = [];
  for (const dayItems of byDay.values()) {
    let currentBand: { firstTs: number; items: T[] } | null = null;
    let prevTs = 0;

    for (const item of dayItems) {
      if (!currentBand || item.completionTs - prevTs >= GAP_MS) {
        currentBand = { firstTs: item.completionTs, items: [] };
        allBands.push(currentBand);
      }
      currentBand.items.push(item);
      prevTs = item.completionTs;
    }
  }

  // Assign labels (no ordinal suffixes — date in label prevents collisions)
  const labeled = allBands.map(band => {
    const label = deriveBandLabel(band.firstTs, now);
    return { label, items: [...band.items].reverse() };
  });

  // Return newest band first
  return labeled.reverse();
}

/**
 * Group items into one band per calendar day, newest day first.
 *
 * The Activity list groups by day, not by burst: gap-clustering a single day
 * into multiple waves renders as "Today" followed by "Today (2)", which reads
 * as a duplicated header rather than two waves. Wave banding (deriveBandKey)
 * stays on the mission timeline, where the burst is the point.
 */
export function deriveDayBands<T extends { id: string; completionTs: number }>(
  items: T[],
  now: Date,
): BandedGroup<T>[] {
  if (items.length === 0) return [];

  const byDay = new Map<string, T[]>();
  for (const item of items) {
    const d = new Date(item.completionTs);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const bucket = byDay.get(key);
    if (bucket) bucket.push(item);
    else byDay.set(key, [item]);
  }

  return [...byDay.values()]
    .map(bucket => {
      const sorted = [...bucket].sort((a, b) => b.completionTs - a.completionTs);
      return { label: deriveBandLabel(sorted[0].completionTs, now), items: sorted };
    })
    .sort((a, b) => b.items[0].completionTs - a.items[0].completionTs);
}
