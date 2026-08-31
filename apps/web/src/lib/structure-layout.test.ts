import { describe, it, expect } from 'bun:test';
import {
  computeStructureLayout,
  computeEdgeSetFingerprint,
  applyRankCap,
  type StructureTask,
  type ContentionEdge,
} from './structure-layout';
import type { CondensedTask, ChainUnit } from './condensed-timeline';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(id: string, overrides: Partial<StructureTask> = {}): StructureTask {
  return {
    id,
    title: `Task ${id}`,
    status: 'pending',
    roleColor: '#8A8478',
    latestWorker: null,
    ...overrides,
  };
}

function makeCondensedTask(id: string, opts: {
  status?: string;
  dependsOn?: string[];
  workerStatus?: string;
  prUrl?: string | null;
  prLifecycleStatus?: string | null;
  mergedAt?: string | null;
} = {}): CondensedTask {
  const w = opts.workerStatus ? {
    id: `w-${id}`,
    status: opts.workerStatus,
    prUrl: opts.prUrl ?? null,
    prNumber: null,
    prLifecycleStatus: opts.prLifecycleStatus ?? null,
    mergedAt: opts.mergedAt ?? null,
    completedAt: null,
    startedAt: null,
    currentAction: null,
    branch: null,
    waitingFor: null,
  } : null;
  return {
    id,
    status: opts.status ?? 'pending',
    dependsOn: opts.dependsOn ?? null,
    workers: w ? [w] : [],
  };
}

function chain(head: StructureTask, tail: StructureTask[] = [], shape: 'linear' | 'fan-out' | 'fan-in' | 'standalone' = 'linear'): ChainUnit<StructureTask> {
  return { head, tail, shape: tail.length === 0 ? 'standalone' : shape };
}

function taskMap(...tasks: CondensedTask[]): Map<string, CondensedTask> {
  return new Map(tasks.map(t => [t.id, t]));
}

// ─── Layout stability test ─────────────────────────────────────────────────────

describe('computeStructureLayout — layout stability', () => {
  it('preserves x,y positions when only task status changes (not deps)', () => {
    // A → B → C: three task linear chain
    const a = makeCondensedTask('a', { status: 'completed', workerStatus: 'completed', prLifecycleStatus: 'merged', mergedAt: '2024-01-01' });
    const b = makeCondensedTask('b', { status: 'running', dependsOn: ['a'], workerStatus: 'running' });
    const c = makeCondensedTask('c', { status: 'pending', dependsOn: ['b'] });
    const tm = taskMap(a, b, c);

    const aTask = makeTask('a', { status: 'completed' });
    const bTask = makeTask('b', { status: 'running' });
    const cTask = makeTask('c', { status: 'pending' });

    const chains1: ChainUnit<StructureTask>[] = [chain(aTask, [bTask, cTask], 'linear')];
    const chains2: ChainUnit<StructureTask>[] = [
      chain(makeTask('a', { status: 'completed' }), [makeTask('b', { status: 'done' as any }), makeTask('c', { status: 'pending' })], 'linear'),
    ];

    const layout1 = computeStructureLayout(chains1, tm, new Set(['a']));  // expanded
    const layout2 = computeStructureLayout(chains2, tm, new Set(['a']));  // same deps, different status

    const node_b1 = layout1.nodes.find(n => n.id === 'b');
    const node_b2 = layout2.nodes.find(n => n.id === 'b');
    expect(node_b1?.x).toBe(node_b2?.x);
    expect(node_b1?.y).toBe(node_b2?.y);
  });

  it('fingerprint does not change when task status changes', () => {
    const a = makeCondensedTask('a', { status: 'completed', dependsOn: [] });
    const b = makeCondensedTask('b', { status: 'pending', dependsOn: ['a'] });
    const tm = taskMap(a, b);

    const aTask1 = makeTask('a', { status: 'completed' });
    const bTask1 = makeTask('b', { status: 'pending' });
    const fp1 = computeEdgeSetFingerprint([chain(aTask1, [bTask1], 'linear')], tm);

    const aTask2 = makeTask('a', { status: 'running' });
    const bTask2 = makeTask('b', { status: 'blocked' as any });
    const fp2 = computeEdgeSetFingerprint([chain(aTask2, [bTask2], 'linear')], tm);

    expect(fp1).toBe(fp2);
  });

  it('fingerprint DOES change when dependsOn edges change', () => {
    const a = makeCondensedTask('a', { status: 'completed', dependsOn: [] });
    const b = makeCondensedTask('b', { status: 'pending', dependsOn: ['a'] });
    const bNoDep = makeCondensedTask('b', { status: 'pending', dependsOn: [] });
    const tm1 = taskMap(a, b);
    const tm2 = taskMap(a, bNoDep);

    const aTask = makeTask('a');
    const bTask = makeTask('b');
    const fp1 = computeEdgeSetFingerprint([chain(aTask, [], 'standalone'), chain(bTask, [], 'standalone')], tm1);
    const fp2 = computeEdgeSetFingerprint([chain(aTask, [], 'standalone'), chain(bTask, [], 'standalone')], tm2);

    expect(fp1).not.toBe(fp2);
  });
});

// ─── Collapse test ─────────────────────────────────────────────────────────────

describe('computeStructureLayout — chain collapse', () => {
  it('a linear 6-task chain produces exactly 1 collapsed node by default', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const cTasks = ids.map((id, i) =>
      makeCondensedTask(id, { dependsOn: i === 0 ? [] : [ids[i - 1]] })
    );
    const tm = taskMap(...cTasks);
    const tasks = ids.map(id => makeTask(id));
    const [head, ...tail] = tasks;
    const chains: ChainUnit<StructureTask>[] = [chain(head, tail, 'linear')];

    const layout = computeStructureLayout(chains, tm, new Set());
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0].isCollapsed).toBe(true);
    expect(layout.nodes[0].chainLength).toBe(6);
  });

  it('expanding the head reveals all 6 individual nodes', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const cTasks = ids.map((id, i) =>
      makeCondensedTask(id, { dependsOn: i === 0 ? [] : [ids[i - 1]] })
    );
    const tm = taskMap(...cTasks);
    const tasks = ids.map(id => makeTask(id));
    const [head, ...tail] = tasks;
    const chains: ChainUnit<StructureTask>[] = [chain(head, tail, 'linear')];

    const layout = computeStructureLayout(chains, tm, new Set([head.id]));
    expect(layout.nodes).toHaveLength(6);
    expect(layout.nodes.every(n => !n.isCollapsed)).toBe(true);
  });

  it('a 1-task linear chain (no tail) is standalone (not collapsed)', () => {
    const ct = makeCondensedTask('a');
    const tm = taskMap(ct);
    const chains: ChainUnit<StructureTask>[] = [chain(makeTask('a'), [], 'standalone')];
    const layout = computeStructureLayout(chains, tm, new Set());
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0].isCollapsed).toBe(false);
  });

  it('collapsed chain segments count equals chain length', () => {
    const ids = ['a', 'b', 'c'];
    const cTasks = ids.map((id, i) =>
      makeCondensedTask(id, { dependsOn: i === 0 ? [] : [ids[i - 1]] })
    );
    const tm = taskMap(...cTasks);
    const tasks = ids.map(id => makeTask(id));
    const [head, ...tail] = tasks;
    const chains: ChainUnit<StructureTask>[] = [chain(head, tail, 'linear')];

    const layout = computeStructureLayout(chains, tm, new Set());
    const node = layout.nodes[0];
    expect(node.segments).toHaveLength(3);
  });
});

// ─── Edge-class test ───────────────────────────────────────────────────────────

describe('computeStructureLayout — edge classes', () => {
  it('dependsOn edges have class="dependsOn"', () => {
    const a = makeCondensedTask('a', { status: 'completed' });
    const b = makeCondensedTask('b', { status: 'pending', dependsOn: ['a'] });
    const tm = taskMap(a, b);
    const chains: ChainUnit<StructureTask>[] = [
      chain(makeTask('a'), [], 'standalone'),
      chain(makeTask('b'), [], 'standalone'),
    ];
    const layout = computeStructureLayout(chains, tm, new Set());
    const edges = layout.edges.filter(e => e.class === 'dependsOn');
    expect(edges.length).toBeGreaterThan(0);
    expect(edges[0].sourceNodeId).toBe('a');
    expect(edges[0].targetNodeId).toBe('b');
  });

  it('contention edges have class="contention" and are distinct from dependsOn', () => {
    const a = makeCondensedTask('a', { status: 'running', workerStatus: 'running' });
    const b = makeCondensedTask('b', { status: 'running', workerStatus: 'running' });
    const tm = taskMap(a, b);
    const contention: ContentionEdge[] = [{ sourceTaskId: 'a', targetTaskId: 'b', paths: ['src/foo.ts'] }];
    const chains: ChainUnit<StructureTask>[] = [
      chain(makeTask('a'), [], 'standalone'),
      chain(makeTask('b'), [], 'standalone'),
    ];
    const layout = computeStructureLayout(chains, tm, new Set(), {
      contentionEdges: contention,
      showContention: true,
    });
    const contentionEdges = layout.edges.filter(e => e.class === 'contention');
    const dependsOnEdges = layout.edges.filter(e => e.class === 'dependsOn');
    expect(contentionEdges.length).toBeGreaterThan(0);
    expect(contentionEdges[0].class).not.toBe('dependsOn');
    expect(contentionEdges[0].contentionPaths).toEqual(['src/foo.ts']);
    // No dependsOn edge between a and b (they have no dep relationship)
    expect(dependsOnEdges.some(e =>
      (e.sourceNodeId === 'a' && e.targetNodeId === 'b') ||
      (e.sourceNodeId === 'b' && e.targetNodeId === 'a')
    )).toBe(false);
  });

  it('contention edges do not appear when showContention is false', () => {
    const a = makeCondensedTask('a');
    const b = makeCondensedTask('b');
    const tm = taskMap(a, b);
    const contention: ContentionEdge[] = [{ sourceTaskId: 'a', targetTaskId: 'b', paths: ['src/bar.ts'] }];
    const chains: ChainUnit<StructureTask>[] = [
      chain(makeTask('a'), [], 'standalone'),
      chain(makeTask('b'), [], 'standalone'),
    ];
    const layout = computeStructureLayout(chains, tm, new Set(), {
      contentionEdges: contention,
      showContention: false,
    });
    expect(layout.edges.filter(e => e.class === 'contention')).toHaveLength(0);
  });
});

// ─── STRANDED detection ────────────────────────────────────────────────────────

describe('computeStructureLayout — STRANDED detection', () => {
  it('marks a task as stranded when its dep failed with no open PR', () => {
    const failedDep = makeCondensedTask('dep', {
      status: 'failed',
      workerStatus: 'completed',
      prLifecycleStatus: 'closed',
    });
    const blocked = makeCondensedTask('blocked', {
      status: 'pending',
      dependsOn: ['dep'],
    });
    const tm = taskMap(failedDep, blocked);
    const chains: ChainUnit<StructureTask>[] = [
      chain(makeTask('dep'), [], 'standalone'),
      chain(makeTask('blocked'), [], 'standalone'),
    ];
    const layout = computeStructureLayout(chains, tm, new Set());
    const strandedNode = layout.nodes.find(n => n.id === 'blocked');
    expect(strandedNode?.isStranded).toBe(true);
  });

  it('does NOT mark a task as stranded when its dep failed but has an open PR', () => {
    const failedDep = makeCondensedTask('dep', {
      status: 'failed',
      workerStatus: 'completed',
      prUrl: 'https://github.com/foo/bar/pull/1',
      prLifecycleStatus: 'pr_open',
    });
    const blocked = makeCondensedTask('blocked', {
      status: 'pending',
      dependsOn: ['dep'],
    });
    const tm = taskMap(failedDep, blocked);
    const chains: ChainUnit<StructureTask>[] = [
      chain(makeTask('dep'), [], 'standalone'),
      chain(makeTask('blocked'), [], 'standalone'),
    ];
    const layout = computeStructureLayout(chains, tm, new Set());
    const node = layout.nodes.find(n => n.id === 'blocked');
    expect(node?.isStranded).toBe(false);
  });

  it('does NOT mark a task as stranded when its dep failed but PR has ci_green (spec §5.2 STF-3)', () => {
    const failedDep = makeCondensedTask('dep', {
      status: 'failed',
      workerStatus: 'completed',
      prUrl: 'https://github.com/foo/bar/pull/2',
      prLifecycleStatus: 'ci_green',
    });
    const blocked = makeCondensedTask('blocked', {
      status: 'pending',
      dependsOn: ['dep'],
    });
    const tm = taskMap(failedDep, blocked);
    const chains: ChainUnit<StructureTask>[] = [
      chain(makeTask('dep'), [], 'standalone'),
      chain(makeTask('blocked'), [], 'standalone'),
    ];
    const layout = computeStructureLayout(chains, tm, new Set());
    const node = layout.nodes.find(n => n.id === 'blocked');
    expect(node?.isStranded).toBe(false);
  });
});

// ─── Rank assignment ───────────────────────────────────────────────────────────

describe('computeStructureLayout — rank assignment', () => {
  it('assigns rank 0 to tasks with no in-scope deps', () => {
    const a = makeCondensedTask('a');
    const tm = taskMap(a);
    const chains: ChainUnit<StructureTask>[] = [chain(makeTask('a'), [], 'standalone')];
    const layout = computeStructureLayout(chains, tm, new Set());
    expect(layout.nodes[0].rank).toBe(0);
  });

  it('assigns incrementing ranks to a linear dependency chain', () => {
    const a = makeCondensedTask('a');
    const b = makeCondensedTask('b', { dependsOn: ['a'] });
    const c = makeCondensedTask('c', { dependsOn: ['b'] });
    const tm = taskMap(a, b, c);
    const chains: ChainUnit<StructureTask>[] = [
      chain(makeTask('a'), [makeTask('b'), makeTask('c')], 'linear'),
    ];
    const layout = computeStructureLayout(chains, tm, new Set(['a'])); // expanded
    const nodeA = layout.nodes.find(n => n.id === 'a')!;
    const nodeB = layout.nodes.find(n => n.id === 'b')!;
    const nodeC = layout.nodes.find(n => n.id === 'c')!;
    expect(nodeA.rank).toBe(0);
    expect(nodeB.rank).toBe(1);
    expect(nodeC.rank).toBe(2);
  });

  it('diamond DAG: assigns correct max rank to the merge node', () => {
    // A → B, A → C, B → D, C → D
    const a = makeCondensedTask('a');
    const b = makeCondensedTask('b', { dependsOn: ['a'] });
    const c = makeCondensedTask('c', { dependsOn: ['a'] });
    const d = makeCondensedTask('d', { dependsOn: ['b', 'c'] });
    const tm = taskMap(a, b, c, d);
    const chains: ChainUnit<StructureTask>[] = [
      chain(makeTask('a'), [], 'standalone'),
      chain(makeTask('b'), [], 'standalone'),
      chain(makeTask('c'), [], 'standalone'),
      chain(makeTask('d'), [], 'standalone'),
    ];
    const layout = computeStructureLayout(chains, tm, new Set());
    const nodeA = layout.nodes.find(n => n.id === 'a')!;
    const nodeB = layout.nodes.find(n => n.id === 'b')!;
    const nodeC = layout.nodes.find(n => n.id === 'c')!;
    const nodeD = layout.nodes.find(n => n.id === 'd')!;
    expect(nodeA.rank).toBe(0);
    expect(nodeB.rank).toBe(1);
    expect(nodeC.rank).toBe(1);
    expect(nodeD.rank).toBe(2);
  });
});

// ─── COL-2: rank cap (spec §3.3) ──────────────────────────────────────────────

describe('applyRankCap — COL-2 rank node cap', () => {
  function make9ParallelNodes() {
    const ids = ['a','b','c','d','e','f','g','h','i'];
    const cTasks = ids.map(id => makeCondensedTask(id));
    const tm = taskMap(...cTasks);
    const chains: ChainUnit<StructureTask>[] = ids.map(id => chain(makeTask(id), [], 'standalone'));
    const layout = computeStructureLayout(chains, tm, new Set());
    return layout.nodes;
  }

  it('9 parallel nodes → 8 visible + 1 overflow when not expanded', () => {
    const nodes = make9ParallelNodes();
    const { visibleNodes, overflows } = applyRankCap(nodes, new Set());
    expect(visibleNodes).toHaveLength(8);
    expect(overflows).toHaveLength(1);
    expect(overflows[0].count).toBe(1);
    expect(overflows[0].rank).toBe(0);
  });

  it('9 parallel nodes → all 9 visible when rank 0 is expanded', () => {
    const nodes = make9ParallelNodes();
    const { visibleNodes, overflows } = applyRankCap(nodes, new Set([0]));
    expect(visibleNodes).toHaveLength(9);
    expect(overflows).toHaveLength(0);
  });

  it('8 parallel nodes → all 8 visible with no overflow', () => {
    const ids = ['a','b','c','d','e','f','g','h'];
    const cTasks = ids.map(id => makeCondensedTask(id));
    const tm = taskMap(...cTasks);
    const chains: ChainUnit<StructureTask>[] = ids.map(id => chain(makeTask(id), [], 'standalone'));
    const layout = computeStructureLayout(chains, tm, new Set());
    const { visibleNodes, overflows } = applyRankCap(layout.nodes, new Set());
    expect(visibleNodes).toHaveLength(8);
    expect(overflows).toHaveLength(0);
  });
});
