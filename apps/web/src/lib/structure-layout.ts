/**
 * Pure layout engine for the mission Structure view.
 * No React, no DOM — returns StructureNode[] and StructureEdge[] with stable
 * pixel coordinates derived from Sugiyama rank assignment + barycenter heuristic.
 *
 * Invariant: x and y coordinates depend only on the edge-set (dependsOn), not
 * on task status, worker state, or PR state. Use computeEdgeSetFingerprint as
 * the useMemo key in StructureView.tsx to guarantee this.
 */

import { deriveStage } from '@/lib/stage';
import type { Stage } from '@/lib/stage';
import type { CondensedTask, ChainUnit } from '@/lib/condensed-timeline';

// ─── Public types ─────────────────────────────────────────────────────────────

/** Minimum task fields the layout engine requires. CondensedTimelineTask satisfies this. */
export type StructureTask = {
  id: string;
  title: string;
  status: string;
  roleColor: string;
  missionBudgetExhausted?: boolean;
  latestWorker: {
    id: string;
    status: string;
    prUrl: string | null;
    prNumber: number | null;
    prLifecycleStatus: string | null;
    mergedAt: string | null;
  } | null;
  loopState?: string | null;
  loopMaxLoops?: number | null;
  loopIteration?: number | null;
  startAt?: string | null;
  loopExitConditionType?: string | null;
};

export type ContentionEdge = {
  sourceTaskId: string;
  targetTaskId: string;
  /** File paths that both tasks touched. */
  paths: string[];
};

export type EdgeClass = 'dependsOn' | 'retry' | 'contention';

export type StructureEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  class: EdgeClass;
  /** Only set for contention edges. */
  contentionPaths?: string[];
};

/** Segment state for the SegmentStrip inside a collapsed chain node. */
export type NodeSegmentState = 'solid' | 'half' | 'ghost' | 'empty' | 'notch';

export type StructureNode<T extends StructureTask = StructureTask> = {
  /** Equals the chain head task id for collapsed chains; equals task id for individual nodes. */
  id: string;
  rank: number;
  pos: number;
  /** x = rank * COL_WIDTH */
  x: number;
  /** y = pos * ROW_HEIGHT */
  y: number;
  /** True when this is a collapsed linear chain (tail.length >= 1, not expanded). */
  isCollapsed: boolean;
  /** Number of tasks represented (1 for standalone, N for chain head). */
  chainLength: number;
  /** Truncated head task title + " · N tasks" suffix for chains. */
  label: string;
  /** Stage of the HEAD task (drives node fill). */
  stage: Stage;
  /** True when the task is stranded (dep is terminal but will never resolve). */
  isStranded: boolean;
  roleColor: string;
  latestWorker: StructureTask['latestWorker'];
  loopState?: string | null;
  loopMaxLoops?: number | null;
  loopIteration?: number | null;
  startAt?: string | null;
  loopExitConditionType?: string | null;
  /** One segment per task for the SegmentStrip inside collapsed chain nodes. */
  segments: Array<{ taskId: string; state: NodeSegmentState }>;
  /** Original task objects — all tasks when collapsed, individual task when expanded. */
  tasks: T[];
};

export type StructureLayout<T extends StructureTask = StructureTask> = {
  nodes: StructureNode<T>[];
  edges: StructureEdge[];
  /** Stable fingerprint of the dependsOn edge-set — use as useMemo key. */
  fingerprint: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

export const COL_WIDTH = 260;
export const ROW_HEIGHT = 120;

// ─── Edge-set fingerprint ─────────────────────────────────────────────────────

/**
 * Returns a stable string representing only the dependsOn edge-set.
 * Identical output for different task statuses with the same topology.
 */
export function computeEdgeSetFingerprint<T extends StructureTask>(
  chains: ChainUnit<T>[],
  taskMap: Map<string, CondensedTask>,
): string {
  const allTasks = chains.flatMap(c => [c.head, ...c.tail]);
  const taskIds = new Set(allTasks.map(t => t.id));
  const edges = allTasks
    .map(t => {
      const deps = (taskMap.get(t.id)?.dependsOn ?? []).filter(d => taskIds.has(d));
      return [t.id, deps.slice().sort()] as [string, string[]];
    })
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(edges);
}

// ─── Stranded detection ───────────────────────────────────────────────────────

const OPEN_PR_STATUSES = new Set(['pr_open', 'ci_running', 'ci_failed', 'conflict']);

function isStrandedTask(taskId: string, taskMap: Map<string, CondensedTask>): boolean {
  const task = taskMap.get(taskId);
  if (!task) return false;
  if (task.status !== 'pending' && task.status !== 'assigned') return false;
  const deps = task.dependsOn ?? [];
  for (const depId of deps) {
    const dep = taskMap.get(depId);
    if (!dep) continue;
    if (dep.status !== 'failed' && dep.status !== 'cancelled') continue;
    const prStatus = dep.workers[0]?.prLifecycleStatus;
    if (!prStatus || !OPEN_PR_STATUSES.has(prStatus)) return true;
  }
  return false;
}

// ─── Stage derivation for a StructureTask ─────────────────────────────────────

function taskStage<T extends StructureTask>(
  task: T,
  taskMap: Map<string, CondensedTask>,
  allTaskIds: Set<string>,
): Stage {
  const condensed = taskMap.get(task.id);
  const deps = condensed?.dependsOn ?? [];
  const isBlocked = deps.some(depId => {
    if (!allTaskIds.has(depId)) return false;
    const dep = taskMap.get(depId);
    if (!dep) return false;
    if (dep.status === 'completed') {
      const w = dep.workers[0];
      // blocked if completed with open PR (gate not satisfied)
      return w?.prUrl != null && w.mergedAt == null && w.prLifecycleStatus !== 'closed';
    }
    return dep.status !== 'failed' && dep.status !== 'cancelled';
  });

  const w = task.latestWorker;
  return deriveStage({
    taskStatus: task.status,
    workerStatus: w?.status ?? null,
    prUrl: w?.prUrl ?? null,
    prLifecycleStatus: w?.prLifecycleStatus ?? null,
    mergedAt: w?.mergedAt ?? null,
    isBlocked,
    isMissionBudgetExhausted: task.missionBudgetExhausted,
  });
}

// ─── Segment state derivation ─────────────────────────────────────────────────

function taskSegmentState<T extends StructureTask>(task: T): NodeSegmentState {
  const s = task.status;
  if (s === 'completed') {
    const w = task.latestWorker;
    if (w?.prUrl && w.mergedAt == null && w.prLifecycleStatus !== 'closed') return 'half';
    return 'solid';
  }
  if (s === 'failed' || s === 'cancelled') return 'notch';
  const ws = task.latestWorker?.status;
  if (ws === 'running' || ws === 'starting' || ws === 'idle' || ws === 'waiting_input') return 'ghost';
  return 'empty';
}

// ─── Kahn rank assignment ─────────────────────────────────────────────────────

function assignRanks(
  taskIds: Set<string>,
  blockerMap: Map<string, string[]>,
): Map<string, number> {
  const ranks = new Map<string, number>();
  const inDegree = new Map<string, number>();
  const dependentsOf = new Map<string, string[]>();

  for (const id of taskIds) {
    ranks.set(id, 0);
    inDegree.set(id, 0);
    dependentsOf.set(id, []);
  }

  for (const [id, blockers] of blockerMap) {
    inDegree.set(id, (inDegree.get(id) ?? 0) + blockers.length);
    for (const b of blockers) {
      dependentsOf.get(b)?.push(id);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const processed = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed.add(id);
    const myRank = ranks.get(id) ?? 0;
    for (const dep of dependentsOf.get(id) ?? []) {
      const newRank = myRank + 1;
      if (newRank > (ranks.get(dep) ?? 0)) ranks.set(dep, newRank);
      const newDeg = (inDegree.get(dep) ?? 1) - 1;
      inDegree.set(dep, newDeg);
      if (newDeg <= 0 && !processed.has(dep)) queue.push(dep);
    }
  }

  // Cycle guard: unprocessed tasks get rank 0
  for (const id of taskIds) {
    if (!processed.has(id)) ranks.set(id, 0);
  }

  return ranks;
}

// ─── Barycenter ordering ──────────────────────────────────────────────────────

function barycentricOrder(
  rankGroups: Map<number, string[]>,
  blockerMap: Map<string, string[]>,
  dependentsOf: Map<string, string[]>,
  ranks: Map<string, number>,
): Map<string, number> {
  const pos = new Map<string, number>();
  if (rankGroups.size === 0) return pos;

  const maxRank = Math.max(...rankGroups.keys());

  for (const [r, nodes] of rankGroups) {
    nodes.forEach((id, i) => pos.set(id, i));
  }

  for (let pass = 0; pass < 2; pass++) {
    const goDown = pass === 0;
    for (let r = goDown ? 1 : maxRank - 1; goDown ? r <= maxRank : r >= 0; goDown ? r++ : r--) {
      const nodes = rankGroups.get(r) ?? [];
      if (nodes.length <= 1) continue;

      const scored = nodes.map(id => {
        const nbrs = goDown
          ? (blockerMap.get(id) ?? []).filter(b => (ranks.get(b) ?? -1) === r - 1)
          : (dependentsOf.get(id) ?? []).filter(d => (ranks.get(d) ?? -1) === r + 1);
        if (nbrs.length === 0) return { id, score: pos.get(id) ?? 0 };
        const mean = nbrs.reduce((acc, n) => acc + (pos.get(n) ?? 0), 0) / nbrs.length;
        return { id, score: mean };
      });

      scored.sort((a, b) => a.score - b.score);
      scored.forEach(({ id }, i) => pos.set(id, i));
    }
  }

  return pos;
}

// ─── Transitive reduction ─────────────────────────────────────────────────────

/**
 * Returns the transitive-reduced edge set. An edge A→C is redundant if C is
 * reachable from A through at least one other path.
 */
function transitiveReduce(
  taskIds: Set<string>,
  dependentsOf: Map<string, string[]>,
): Map<string, string[]> {
  // Build full reachability (BFS per node)
  const reachable = new Map<string, Set<string>>();
  for (const id of taskIds) {
    const visited = new Set<string>();
    const queue = [...(dependentsOf.get(id) ?? [])];
    while (queue.length > 0) {
      const n = queue.shift()!;
      if (visited.has(n)) continue;
      visited.add(n);
      for (const d of dependentsOf.get(n) ?? []) {
        if (!visited.has(d)) queue.push(d);
      }
    }
    reachable.set(id, visited);
  }

  const reduced = new Map<string, string[]>();
  for (const id of taskIds) {
    const direct = dependentsOf.get(id) ?? [];
    const kept = direct.filter(target => {
      // Keep edge id→target only if target is NOT reachable from id through
      // another direct successor of id.
      const otherSuccessors = direct.filter(d => d !== target);
      return !otherSuccessors.some(d => reachable.get(d)?.has(target));
    });
    reduced.set(id, kept);
  }
  return reduced;
}

// ─── Main layout function ─────────────────────────────────────────────────────

export function computeStructureLayout<T extends StructureTask>(
  chains: ChainUnit<T>[],
  taskMap: Map<string, CondensedTask>,
  expandedChainHeadIds: Set<string>,
  options?: {
    retryLinks?: Map<string, string>;
    contentionEdges?: ContentionEdge[];
    showRetries?: boolean;
    showContention?: boolean;
  },
): StructureLayout<T> {
  const { retryLinks, contentionEdges, showRetries = true, showContention = false } = options ?? {};

  // ── 1. Flatten all tasks ──────────────────────────────────────────────────
  const allTasks: T[] = chains.flatMap(c => [c.head, ...c.tail]);
  const taskById = new Map(allTasks.map(t => [t.id, t]));
  const allTaskIds = new Set(allTasks.map(t => t.id));

  // ── 2. Build task-level adjacency from condensed taskMap ──────────────────
  const blockerMap = new Map<string, string[]>(); // id → in-scope blockers
  const dependentsOf = new Map<string, string[]>(); // id → in-scope dependents

  for (const id of allTaskIds) {
    blockerMap.set(id, []);
    dependentsOf.set(id, []);
  }
  for (const id of allTaskIds) {
    const deps = taskMap.get(id)?.dependsOn ?? [];
    const inScope = deps.filter(d => allTaskIds.has(d));
    blockerMap.set(id, inScope);
    for (const d of inScope) {
      dependentsOf.get(d)?.push(id);
    }
  }

  // ── 3. Compute fingerprint ────────────────────────────────────────────────
  const fingerprint = computeEdgeSetFingerprint(chains, taskMap);

  // ── 4. Assign ranks via Kahn's algorithm ──────────────────────────────────
  const ranks = assignRanks(allTaskIds, blockerMap);

  // ── 5. Partition by rank ──────────────────────────────────────────────────
  const rankGroups = new Map<number, string[]>();
  for (const [id, r] of ranks) {
    if (!rankGroups.has(r)) rankGroups.set(r, []);
    rankGroups.get(r)!.push(id);
  }

  // ── 6. Barycenter within-rank ordering ───────────────────────────────────
  const positions = barycentricOrder(rankGroups, blockerMap, dependentsOf, ranks);

  // ── 7. Determine which tasks are "render nodes" ───────────────────────────
  // Map from taskId → nodeId (collapsed chain: all tasks map to head.id)
  const taskToNodeId = new Map<string, string>();
  // Map from nodeId → chain for collapsed chains
  const collapsedChainByNodeId = new Map<string, ChainUnit<T>>();

  for (const ch of chains) {
    const isCollapsible = ch.shape === 'linear' && ch.tail.length >= 1;
    const isExpanded = expandedChainHeadIds.has(ch.head.id);
    if (isCollapsible && !isExpanded) {
      // Collapsed: all tasks map to head's node id
      for (const t of [ch.head, ...ch.tail]) {
        taskToNodeId.set(t.id, ch.head.id);
      }
      collapsedChainByNodeId.set(ch.head.id, ch);
    } else {
      // Expanded or non-linear: each task is its own node
      for (const t of [ch.head, ...ch.tail]) {
        taskToNodeId.set(t.id, t.id);
      }
    }
  }

  // Collect unique node ids (preserving first-seen order)
  const nodeIdsSeen = new Set<string>();
  const nodeIds: string[] = [];
  for (const t of allTasks) {
    const nid = taskToNodeId.get(t.id)!;
    if (!nodeIdsSeen.has(nid)) {
      nodeIdsSeen.add(nid);
      nodeIds.push(nid);
    }
  }

  // ── 8. Build StructureNode objects ────────────────────────────────────────
  const nodes: StructureNode<T>[] = nodeIds.map(nodeId => {
    const collapsed = collapsedChainByNodeId.get(nodeId);
    const headId = nodeId;
    const headTask = taskById.get(headId)!;
    const headCondensed = taskMap.get(headId);

    const rank = ranks.get(headId) ?? 0;
    const pos = positions.get(headId) ?? 0;

    if (collapsed) {
      // Collapsed chain node
      const chainTasks = [collapsed.head, ...collapsed.tail];
      const stage = taskStage(headTask, taskMap, allTaskIds);
      const isStranded = isStrandedTask(headId, taskMap);
      const titlePrefix = headTask.title.length > 32
        ? headTask.title.slice(0, 32) + '…'
        : headTask.title;
      const label = `${titlePrefix} · ${chainTasks.length} tasks`;
      const segments = chainTasks.map(t => ({ taskId: t.id, state: taskSegmentState(t) }));

      return {
        id: nodeId,
        rank,
        pos,
        x: rank * COL_WIDTH,
        y: pos * ROW_HEIGHT,
        isCollapsed: true,
        chainLength: chainTasks.length,
        label,
        stage,
        isStranded,
        roleColor: headTask.roleColor,
        latestWorker: headTask.latestWorker,
        loopState: headTask.loopState,
        loopMaxLoops: headTask.loopMaxLoops,
        loopIteration: headTask.loopIteration,
        startAt: headTask.startAt,
        loopExitConditionType: headTask.loopExitConditionType,
        segments,
        tasks: chainTasks,
      };
    } else {
      // Individual task node
      const stage = taskStage(headTask, taskMap, allTaskIds);
      const isStranded = isStrandedTask(headId, taskMap);

      return {
        id: nodeId,
        rank,
        pos,
        x: rank * COL_WIDTH,
        y: pos * ROW_HEIGHT,
        isCollapsed: false,
        chainLength: 1,
        label: headTask.title.length > 32 ? headTask.title.slice(0, 32) + '…' : headTask.title,
        stage,
        isStranded,
        roleColor: headTask.roleColor,
        latestWorker: headTask.latestWorker,
        loopState: headTask.loopState,
        loopMaxLoops: headTask.loopMaxLoops,
        loopIteration: headTask.loopIteration,
        startAt: headTask.startAt,
        loopExitConditionType: headTask.loopExitConditionType,
        segments: [{ taskId: nodeId, state: taskSegmentState(headTask) }],
        tasks: [headTask],
      };
    }
  });

  // ── 9. Build edges ────────────────────────────────────────────────────────
  // Transitive reduction at task level, then map to node level
  const reducedDependentsOf = transitiveReduce(allTaskIds, dependentsOf);

  const edges: StructureEdge[] = [];
  const edgeSet = new Set<string>();

  const addEdge = (srcNodeId: string, tgtNodeId: string, cls: EdgeClass, paths?: string[]) => {
    if (srcNodeId === tgtNodeId) return; // skip self-loops (internal chain edges)
    const key = `${cls}:${srcNodeId}→${tgtNodeId}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({
      id: key,
      sourceNodeId: srcNodeId,
      targetNodeId: tgtNodeId,
      class: cls,
      ...(paths ? { contentionPaths: paths } : {}),
    });
  };

  // dependsOn edges (transitive-reduced)
  for (const [srcId, targets] of reducedDependentsOf) {
    const srcNodeId = taskToNodeId.get(srcId)!;
    for (const tgtId of targets) {
      const tgtNodeId = taskToNodeId.get(tgtId)!;
      addEdge(srcNodeId, tgtNodeId, 'dependsOn');
    }
  }

  // Retry lineage edges
  if (showRetries && retryLinks) {
    for (const [childId, parentId] of retryLinks) {
      const srcNodeId = taskToNodeId.get(parentId);
      const tgtNodeId = taskToNodeId.get(childId);
      if (srcNodeId && tgtNodeId) addEdge(srcNodeId, tgtNodeId, 'retry');
    }
  }

  // Contention edges
  if (showContention && contentionEdges) {
    for (const ce of contentionEdges) {
      const srcNodeId = taskToNodeId.get(ce.sourceTaskId);
      const tgtNodeId = taskToNodeId.get(ce.targetTaskId);
      if (srcNodeId && tgtNodeId && srcNodeId !== tgtNodeId) {
        // Bidirectional: add one edge, render as undirected
        addEdge(srcNodeId, tgtNodeId, 'contention', ce.paths);
      }
    }
  }

  return { nodes, edges, fingerprint };
}
