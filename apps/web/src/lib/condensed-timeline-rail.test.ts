/**
 * Mobile timeline rail — docs/specs/timeline-mobile-rail.md.
 *
 * Two surfaces under test:
 *   - `identifyChains()`'s terminal pass (D1) — a landed SPEC→BUILD→REVIEW run
 *     collapses to ONE chain unit instead of three standalone rows.
 *   - `buildRail()` (D2–D5, D8) — the pure rail model the mobile render branch
 *     walks: lanes, edge classes, day/now ticks, goal root.
 */

import { describe, it, expect } from 'bun:test';
import { identifyChains, buildRail, railOutcome, rollupRailOutcome } from './condensed-timeline';
import type {
  CondensedTask,
  ChainUnit,
  RailTaskLike,
  RailNode,
  RailAttemptLike,
  RailOutcomeTask,
} from './condensed-timeline';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<CondensedTask> & { id: string }): CondensedTask {
  return { status: 'pending', dependsOn: null, workers: [], ...overrides };
}

/** A completed task whose PR merged — gate-satisfied, so invisible to the unresolved pass. */
function merged(id: string, dependsOn: string[] | null = null): CondensedTask {
  return makeTask({
    id,
    status: 'completed',
    dependsOn,
    workers: [
      {
        id: `w-${id}`,
        status: 'completed',
        prUrl: `https://github.com/o/r/pull/1`,
        prNumber: 1,
        prLifecycleStatus: 'merged',
        mergedAt: '2026-09-12T10:00:00.000Z',
        completedAt: '2026-09-12T10:00:00.000Z',
        startedAt: '2026-09-12T09:00:00.000Z',
        currentAction: null,
        branch: null,
        waitingFor: null,
      },
    ],
  });
}

function mapOf(tasks: CondensedTask[]) {
  return new Map(tasks.map(t => [t.id, t]));
}

type RT = RailTaskLike;

function rt(id: string, o: Partial<RT> = {}): RT {
  return {
    id,
    status: 'completed',
    dependsOn: null,
    pathManifest: null,
    taskCreatedAt: '2026-09-12T10:00:00.000Z',
    taskUpdatedAt: '2026-09-12T10:00:00.000Z',
    latestWorker: null,
    ...o,
  };
}

function unit<T>(head: T, tail: T[] = [], shape: ChainUnit<T>['shape'] = tail.length ? 'linear' : 'standalone'): ChainUnit<T> {
  return { head, tail, shape };
}

const EMPTY_GROUPS = {
  waitingOnYou: [] as ChainUnit<RT>[],
  running: [] as ChainUnit<RT>[],
  nextQueued: [] as ChainUnit<RT>[],
  blocked: [] as ChainUnit<RT>[],
  done: [] as ChainUnit<RT>[],
  failed: [] as ChainUnit<RT>[],
};

const nodes = <T,>(rows: Array<{ kind: string }>): RailNode<T>[] =>
  rows.filter(r => r.kind === 'node') as RailNode<T>[];

// ─── D1: chain identity in history ───────────────────────────────────────────

describe('identifyChains — terminal chain collapse (D1)', () => {
  it('collapses a landed SPEC→BUILD→REVIEW run into one chain unit (AC-1)', () => {
    // Newest-first, exactly the order the mission page feeds in.
    const review = merged('review', ['build']);
    const build = merged('build', ['spec']);
    const spec = merged('spec');
    const tasks = [review, build, spec];

    const chains = identifyChains(tasks, mapOf(tasks));

    expect(chains).toHaveLength(1);
    expect(chains[0].shape).toBe('linear');
    expect(chains[0].head.id).toBe('spec');
    // D1-3: topological order — blocker before blocked.
    expect(chains[0].tail.map(t => t.id)).toEqual(['build', 'review']);
  });

  it('collapses a 2-task terminal chain too — posture is not length-gated (AC-2)', () => {
    const build = merged('build', ['spec']);
    const spec = merged('spec');
    const tasks = [build, spec];

    const chains = identifyChains(tasks, mapOf(tasks));

    expect(chains).toHaveLength(1);
    expect(chains[0].head.id).toBe('spec');
    expect(chains[0].tail.map(t => t.id)).toEqual(['build']);
  });

  it('links a failed task into the terminal chain — terminal means completed OR failed', () => {
    const build = makeTask({ id: 'build', status: 'failed', dependsOn: ['spec'] });
    const spec = merged('spec');
    const tasks = [build, spec];

    const chains = identifyChains(tasks, mapOf(tasks));

    expect(chains).toHaveLength(1);
    expect(chains[0].tail.map(t => t.id)).toEqual(['build']);
  });

  it('does NOT fold retry lineage into the ordinal chain — parentTaskId is not a dependsOn edge (D1-2)', () => {
    const review = merged('review', ['build']);
    const build = merged('build', ['spec']);
    const spec = merged('spec');
    // The retry carries no dependsOn edge; its lineage is parentTaskId only.
    const retry = merged('build-retry');
    const tasks = [retry, review, build, spec];

    const chains = identifyChains(tasks, mapOf(tasks));

    const linear = chains.find(c => c.shape === 'linear')!;
    expect(linear.tail).toHaveLength(2);
    expect([linear.head.id, ...linear.tail.map(t => t.id)]).toEqual(['spec', 'build', 'review']);
    expect(chains.some(c => c.shape === 'standalone' && c.head.id === 'build-retry')).toBe(true);
  });

  it('produces a fan-out unit when a terminal head has several terminal dependents', () => {
    const head = merged('head');
    const a = merged('a', ['head']);
    const b = merged('b', ['head']);
    const c = merged('c', ['head']);
    const tasks = [c, b, a, head];

    const chains = identifyChains(tasks, mapOf(tasks));

    expect(chains).toHaveLength(1);
    expect(chains[0].shape).toBe('fan-out');
    expect(chains[0].head.id).toBe('head');
    expect(chains[0].tail.map(t => t.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('leaves non-terminal grouping untouched — a pending chain still comes from the unresolved pass', () => {
    const spec = makeTask({
      id: 'spec',
      status: 'completed',
      workers: [
        {
          id: 'w', status: 'completed', prUrl: 'https://x/pull/2', prNumber: 2,
          prLifecycleStatus: 'pr_open', mergedAt: null, completedAt: null,
          startedAt: null, currentAction: null, branch: null, waitingFor: null,
        },
      ],
    });
    const build = makeTask({ id: 'build', status: 'pending', dependsOn: ['spec'] });
    const tasks = [build, spec];

    const chains = identifyChains(tasks, mapOf(tasks));

    expect(chains).toHaveLength(1);
    expect(chains[0].head.id).toBe('spec');
    expect(chains[0].tail.map(t => t.id)).toEqual(['build']);
  });

  it('is a no-op for a single terminal task', () => {
    const tasks = [merged('only')];
    const chains = identifyChains(tasks, mapOf(tasks));
    expect(chains).toHaveLength(1);
    expect(chains[0].shape).toBe('standalone');
  });
});

// ─── D2: lanes ────────────────────────────────────────────────────────────────

describe('buildRail — lanes (D2)', () => {
  it('renders a collapsed chain as one node carrying its ordinal members and count', () => {
    const chain = unit(rt('spec'), [rt('build'), rt('review')], 'linear');
    const model = buildRail({ ...EMPTY_GROUPS, done: [chain] }, { now: new Date('2026-09-12T12:00:00Z') });

    const [node] = nodes<RT>(model.rows);
    expect(node.count).toBe(3);
    expect(node.members.map(t => t.id)).toEqual(['spec', 'build', 'review']);
  });

  it('collapses a fan-out wider than the lane cap to 2 siblings plus a fork count (AC-10)', () => {
    const chain = unit(
      rt('head'),
      [rt('s1', { dependsOn: ['head'] }), rt('s2', { dependsOn: ['head'] }), rt('s3', { dependsOn: ['head'] }), rt('s4', { dependsOn: ['head'] })],
      'fan-out',
    );
    const model = buildRail({ ...EMPTY_GROUPS, done: [chain] }, { now: new Date('2026-09-12T12:00:00Z') });

    const [node] = nodes<RT>(model.rows);
    expect(node.siblings).toHaveLength(2);
    expect(node.forkHidden).toBe(2);
    // Fan-out siblings are lane 2, never ordinal members of the lane-1 chain.
    expect(node.count).toBe(1);
  });

  it('keeps a fan-out of exactly 2 fully expanded — no fork glyph under the cap', () => {
    const chain = unit(rt('head'), [rt('s1', { dependsOn: ['head'] }), rt('s2', { dependsOn: ['head'] })], 'fan-out');
    const model = buildRail({ ...EMPTY_GROUPS, done: [chain] }, { now: new Date('2026-09-12T12:00:00Z') });

    const [node] = nodes<RT>(model.rows);
    expect(node.siblings).toHaveLength(2);
    expect(node.forkHidden).toBe(0);
  });

  it('carries no retry lane at all — a retry is a node property, not a branch (Rule D3-5/D3-6)', () => {
    const chain = unit(rt('spec'), [rt('build'), rt('review')], 'linear');
    const model = buildRail({ ...EMPTY_GROUPS, done: [chain] }, { now: new Date('2026-09-12T12:00:00Z') });

    const [node] = nodes<RT>(model.rows);
    expect('retries' in node).toBe(false);
    expect(node.count).toBe(3);
  });

  it('spends the whole lane-2 budget on siblings — no reservation for a retry (Rule D2-4)', () => {
    // v1 shrank the sibling budget to `laneCap - 1` whenever a retry existed, so
    // a fan-out of exactly 2 could be truncated to 1 by something unrelated to it.
    const chain = unit(
      rt('head'),
      [rt('s1', { dependsOn: ['head'] }), rt('s2', { dependsOn: ['head'] })],
      'fan-out',
    );
    const model = buildRail({ ...EMPTY_GROUPS, done: [chain] }, { now: new Date('2026-09-12T12:00:00Z') });

    const [node] = nodes<RT>(model.rows);
    expect(node.siblings.map(s => s.task.id)).toEqual(['s1', 's2']);
    expect(node.forkHidden).toBe(0);
  });
});

// ─── D3: edge classes ─────────────────────────────────────────────────────────

describe('buildRail — edge classes (D3)', () => {
  it('marks a dependsOn edge between consecutive rail nodes as hard', () => {
    const a = unit(rt('a', { taskUpdatedAt: '2026-09-12T09:00:00.000Z' }));
    const b = unit(rt('b', { dependsOn: ['a'], taskUpdatedAt: '2026-09-12T10:00:00.000Z' }));
    const model = buildRail({ ...EMPTY_GROUPS, done: [a, b] }, { now: new Date('2026-09-12T12:00:00Z') });

    const railNodes = nodes<RT>(model.rows);
    expect(railNodes[0].edge).toBe('none');
    expect(railNodes[1].edge).toBe('hard');
  });

  it('marks the later sibling soft when pathManifest would serialize it and no dependsOn edge exists (AC-4)', () => {
    const chain = unit(
      rt('head'),
      [
        rt('early', { dependsOn: ['head'], pathManifest: ['apps/web/src/lib/a.ts'], taskCreatedAt: '2026-09-12T08:00:00.000Z' }),
        rt('late', { dependsOn: ['head'], pathManifest: ['apps/web/src/lib/a.ts'], taskCreatedAt: '2026-09-12T09:00:00.000Z' }),
      ],
      'fan-out',
    );
    const model = buildRail({ ...EMPTY_GROUPS, nextQueued: [chain] }, { now: new Date('2026-09-12T12:00:00Z') });

    const [node] = nodes<RT>(model.rows);
    expect(node.siblings.find(s => s.task.id === 'early')!.soft).toBe(false);
    expect(node.siblings.find(s => s.task.id === 'late')!.soft).toBe(true);
  });

  it('never marks siblings soft when a repo-wide sentinel manifest is involved', () => {
    const chain = unit(
      rt('head'),
      [
        rt('early', { dependsOn: ['head'], pathManifest: ['**'], taskCreatedAt: '2026-09-12T08:00:00.000Z' }),
        rt('late', { dependsOn: ['head'], pathManifest: ['apps/web/src/lib/a.ts'], taskCreatedAt: '2026-09-12T09:00:00.000Z' }),
      ],
      'fan-out',
    );
    const model = buildRail({ ...EMPTY_GROUPS, nextQueued: [chain] }, { now: new Date('2026-09-12T12:00:00Z') });

    const [node] = nodes<RT>(model.rows);
    expect(node.siblings.every(s => !s.soft)).toBe(true);
  });

  it('never marks a sibling soft when a stored dependsOn edge already links the pair (D3-4)', () => {
    const chain = unit(
      rt('head'),
      [
        rt('early', { dependsOn: ['head'], pathManifest: ['apps/web/src/lib/a.ts'], taskCreatedAt: '2026-09-12T08:00:00.000Z' }),
        rt('late', { dependsOn: ['head', 'early'], pathManifest: ['apps/web/src/lib/a.ts'], taskCreatedAt: '2026-09-12T09:00:00.000Z' }),
      ],
      'fan-out',
    );
    const model = buildRail({ ...EMPTY_GROUPS, nextQueued: [chain] }, { now: new Date('2026-09-12T12:00:00Z') });

    const [node] = nodes<RT>(model.rows);
    expect(node.siblings.every(s => !s.soft)).toBe(true);
  });

  it('never marks the top-level edge between two unrelated Lane-1 chains soft, even with overlapping pathManifest (D3-3 scope)', () => {
    // Two standalone, already-landed chains — not siblings, not a Lane-1/fork
    // pair — that happen to declare overlapping paths. D3-3 scopes the dashed
    // "advisory ordering" treatment to Lane-2 sibling pairs; it must not leak
    // onto arbitrary consecutive top-level rail nodes.
    const a = unit(rt('a', { pathManifest: ['apps/web/src/lib/a.ts'], taskUpdatedAt: '2026-09-12T09:00:00.000Z', latestWorker: { mergedAt: '2026-09-12T09:00:00.000Z', prLifecycleStatus: 'merged' } }));
    const b = unit(rt('b', { pathManifest: ['apps/web/src/lib/a.ts'], taskUpdatedAt: '2026-09-12T10:00:00.000Z', latestWorker: { mergedAt: '2026-09-12T10:00:00.000Z', prLifecycleStatus: 'merged' } }));
    const model = buildRail({ ...EMPTY_GROUPS, done: [a, b] }, { now: new Date('2026-09-12T12:00:00Z') });

    const railNodes = nodes<RT>(model.rows);
    expect(railNodes.map(n => n.edge)).toEqual(['none', 'none']);
  });
});

// ─── D4: ticks ────────────────────────────────────────────────────────────────

describe('buildRail — day and now ticks (D4)', () => {
  const now = new Date('2026-09-13T12:00:00.000Z'); // Sunday

  it('emits one tick per calendar-day transition and never a duplicate label (AC-5)', () => {
    const mk = (id: string, iso: string) =>
      unit(rt(id, { taskUpdatedAt: iso, latestWorker: { mergedAt: iso, prLifecycleStatus: 'merged' } }));
    const model = buildRail(
      {
        ...EMPTY_GROUPS,
        done: [
          mk('f1', '2026-09-11T09:00:00.000Z'),
          mk('f2', '2026-09-11T20:00:00.000Z'), // same day, 11h gap — still one tick
          mk('s1', '2026-09-12T09:00:00.000Z'),
        ],
      },
      { now },
    );

    const ticks = model.rows.filter(r => r.kind === 'tick') as Array<{ label: string; now: boolean }>;
    const labels = ticks.map(t => t.label);
    expect(new Set(labels).size).toBe(labels.length); // no duplicate headers
    expect(labels.some(l => /\(\d\)$/.test(l))).toBe(false); // no ordinal suffixes
    expect(labels.filter(l => !l.startsWith('now')).length).toBe(2);
  });

  it('emits exactly one now tick, at the boundary before the first not-yet-started node (D4-5)', () => {
    const done = unit(rt('d', { taskUpdatedAt: '2026-09-12T09:00:00.000Z', latestWorker: { mergedAt: '2026-09-12T09:00:00.000Z', prLifecycleStatus: 'merged' } }));
    const queued = unit(rt('q', { status: 'pending', taskCreatedAt: '2026-09-13T09:00:00.000Z' }));
    const model = buildRail({ ...EMPTY_GROUPS, done: [done], nextQueued: [queued] }, { now });

    const ticks = model.rows.filter(r => r.kind === 'tick') as Array<{ label: string; now: boolean }>;
    expect(ticks.filter(t => t.now)).toHaveLength(1);

    const idx = model.rows.findIndex(r => r.kind === 'tick' && (r as any).now);
    const qIdx = model.rows.findIndex(r => r.kind === 'node' && (r as any).id === 'q');
    const dIdx = model.rows.findIndex(r => r.kind === 'node' && (r as any).id === 'd');
    expect(dIdx).toBeLessThan(idx);
    expect(idx).toBeLessThan(qIdx);
  });

  it('merges the now tick into that day tick rather than emitting a duplicate pair for one day', () => {
    const done = unit(rt('d', { taskUpdatedAt: '2026-09-12T09:00:00.000Z', latestWorker: { mergedAt: '2026-09-12T09:00:00.000Z', prLifecycleStatus: 'merged' } }));
    const queued = unit(rt('q', { status: 'pending', taskCreatedAt: '2026-09-13T09:00:00.000Z' }));
    const model = buildRail({ ...EMPTY_GROUPS, done: [done], nextQueued: [queued] }, { now });

    const ticks = model.rows.filter(r => r.kind === 'tick') as Array<{ label: string; now: boolean }>;
    const nowTick = ticks.find(t => t.now)!;
    expect(nowTick.label.startsWith('now · ')).toBe(true);
    // Its day is not repeated by a bare day tick.
    const day = nowTick.label.replace('now · ', '');
    expect(ticks.filter(t => t.label === day)).toHaveLength(0);
  });

  it('renders no rows at all for an empty mission', () => {
    const model = buildRail({ ...EMPTY_GROUPS }, { now });
    expect(model.rows).toHaveLength(0);
  });
});

// ─── D8: section labels ───────────────────────────────────────────────────────

describe('buildRail — surviving section labels (D8)', () => {
  const now = new Date('2026-09-13T12:00:00.000Z');

  it('emits "waiting on you" and "running" at most once each, and no other label', () => {
    const model = buildRail(
      {
        ...EMPTY_GROUPS,
        waitingOnYou: [unit(rt('w'))],
        running: [unit(rt('r', { status: 'running' }))],
        nextQueued: [unit(rt('q', { status: 'pending' }))],
        blocked: [unit(rt('b', { status: 'pending' }))],
        done: [unit(rt('d'))],
      },
      { now },
    );

    const labels = (model.rows.filter(r => r.kind === 'label') as Array<{ text: string }>).map(l => l.text);
    expect(labels).toEqual(['waiting on you', 'running']);
  });

  it('renders the waitingOnYou/running block above ticked history, not below it (D8-3)', () => {
    const model = buildRail(
      {
        ...EMPTY_GROUPS,
        waitingOnYou: [unit(rt('w'))],
        running: [unit(rt('r', { status: 'running' }))],
        done: [
          unit(rt('old', { taskUpdatedAt: '2026-09-10T09:00:00.000Z', latestWorker: { mergedAt: '2026-09-10T09:00:00.000Z', prLifecycleStatus: 'merged' } })),
        ],
      },
      { now },
    );

    const labelIdx = model.rows.findIndex(r => r.kind === 'label');
    const dayTickIdx = model.rows.findIndex(r => r.kind === 'tick' && !(r as any).now);
    const wIdx = model.rows.findIndex(r => r.kind === 'node' && (r as any).id === 'w');
    const rIdx = model.rows.findIndex(r => r.kind === 'node' && (r as any).id === 'r');
    const oldIdx = model.rows.findIndex(r => r.kind === 'node' && (r as any).id === 'old');

    // Both live-work nodes, and both their labels, sit above every day tick
    // and above the ticked-history node — never the other way around.
    expect(labelIdx).toBeLessThan(dayTickIdx);
    expect(wIdx).toBeLessThan(dayTickIdx);
    expect(rIdx).toBeLessThan(dayTickIdx);
    expect(wIdx).toBeLessThan(oldIdx);
    expect(rIdx).toBeLessThan(oldIdx);
  });
});

// ─── D5: goal root ────────────────────────────────────────────────────────────

describe('buildRail — goal root (D5)', () => {
  const now = new Date('2026-09-13T12:00:00.000Z');

  it('renders a goal root with the pass count (AC-6)', () => {
    const model = buildRail({ ...EMPTY_GROUPS, done: [unit(rt('d'))] }, { now, goal: { total: 3, passed: 2 } });
    expect(model.goal).toEqual({ total: 3, passed: 2 });
  });

  it('reports an unevaluated gate as an unknown count, never zero (D5-3)', () => {
    const model = buildRail({ ...EMPTY_GROUPS, done: [unit(rt('d'))] }, { now, goal: { total: 3, passed: null } });
    expect(model.goal).toEqual({ total: 3, passed: null });
  });

  it('renders no goal root when the mission has no criteria (AC-7)', () => {
    const model = buildRail({ ...EMPTY_GROUPS, done: [unit(rt('d'))] }, { now });
    expect(model.goal).toBeNull();
  });

  it('renders no goal root for an empty criteria array', () => {
    const model = buildRail({ ...EMPTY_GROUPS, done: [unit(rt('d'))] }, { now, goal: { total: 0, passed: 0 } });
    expect(model.goal).toBeNull();
  });
});

// ─── §6.4: the outcome mark (v2) ──────────────────────────────────────────────

/**
 * `railOutcome` is the whole of the v2 encoding: five states in one precedence
 * order, and a *silent* healthy path. The rate argument in §0.2 Finding 3 is
 * what these tests protect — a mark that fires on the common case is a bug, not
 * a cosmetic choice.
 */
describe('railOutcome — the encoding (D6-5)', () => {
  const att = (o: Partial<RailAttemptLike> = {}): RailAttemptLike => ({
    status: 'completed',
    settled: true,
    iteration: null,
    maxIterations: null,
    ...o,
  });

  const strip = (attempts: RailAttemptLike[]) => ({ total: attempts.length, attempts });

  const row = (o: Partial<RailOutcomeTask> = {}): RailOutcomeTask => ({
    attempts: null,
    latestWorker: null,
    reviewerNote: null,
    reviewerRetryTask: null,
    missionBudgetExhausted: false,
    ...o,
  });

  const mergedWorker = { mergedAt: '2026-09-12T10:00:00.000Z', prLifecycleStatus: 'merged' };
  const openWorker = { mergedAt: null, prLifecycleStatus: 'pr_open' };

  it('renders nothing at all for a row with no attempt history (AC-11, AC-22)', () => {
    const out = railOutcome(row({ latestWorker: mergedWorker }));
    expect(out.state).toBe('clean');
    expect(out.mark).toBeNull();
    expect(out.hasAttempts).toBe(false);
  });

  it('renders no mark for a failed task whose every worker died before a retry (AC-22)', () => {
    const out = railOutcome(row({ attempts: null, latestWorker: null }));
    expect(out.mark).toBeNull();
    expect(out.hasAttempts).toBe(false);
  });

  it('is silent on a merge that took a reviewer round which landed (AC-12, AC-18)', () => {
    const out = railOutcome(row({
      attempts: strip([att()]),
      latestWorker: mergedWorker,
      reviewerNote: { type: 'reviewer_approved', status: 'answered' },
      reviewerRetryTask: { status: 'completed', prNumber: 2295 },
    }));
    expect(out.state).toBe('clean');
    expect(out.mark).toBeNull();
    // The chevron is the only thing distinguishing it from AC-11's row.
    expect(out.hasAttempts).toBe(true);
  });

  it('marks a merged row whose request-changes verdict was never made terminal (AC-13)', () => {
    const out = railOutcome(row({
      attempts: strip([att()]),
      latestWorker: mergedWorker,
      reviewerNote: { type: 'reviewer_request_changes', status: 'open' },
    }));
    expect(out.state).toBe('unlanded');
    expect(out.mark).toBe('!');
    expect(out.tone).toBe('text-status-warning');
  });

  it('marks a merged row whose reviewer retry completed without ever attaching to a PR (AC-13)', () => {
    const out = railOutcome(row({
      attempts: strip([att()]),
      latestWorker: mergedWorker,
      reviewerNote: { type: 'reviewer_approved', status: 'answered' },
      reviewerRetryTask: { status: 'completed', prNumber: null },
    }));
    expect(out.state).toBe('unlanded');
    expect(out.mark).toBe('!');
  });

  it('treats an escalated-but-open verdict the same as request-changes (Rule D6-7)', () => {
    const out = railOutcome(row({
      attempts: strip([att()]),
      latestWorker: mergedWorker,
      reviewerNote: { type: 'reviewer_escalated', status: 'open' },
    }));
    expect(out.state).toBe('unlanded');
  });

  it('never reaches `unlanded` on a row that did not merge (Rule D6-7 precondition)', () => {
    const out = railOutcome(row({
      attempts: strip([att()]),
      latestWorker: openWorker,
      reviewerNote: { type: 'reviewer_request_changes', status: 'open' },
    }));
    expect(out.state).toBe('clean');
    expect(out.mark).toBeNull();
  });

  it('renders the dot ledger while a re-run is in flight, never ✗ or ! (AC-14)', () => {
    const out = railOutcome(row({
      attempts: strip([att(), att({ status: 'running', settled: false })]),
      latestWorker: openWorker,
    }));
    expect(out.state).toBe('live');
    expect(out.mark).toBe('●○');
    expect(out.tone).toBe('text-text-muted');
  });

  it('dashes a dormant dot when the mission budget wall is up (AC-31, Rule D6-11)', () => {
    const out = railOutcome(row({
      attempts: strip([att(), att({ status: 'pending', settled: false })]),
      missionBudgetExhausted: true,
    }));
    expect(out.mark).toBe('●◌');
  });

  it('leaves every other parked reason hollow — it is not derivable here (Rule D6-11)', () => {
    const out = railOutcome(row({
      attempts: strip([att({ status: 'pending', settled: false })]),
      missionBudgetExhausted: false,
    }));
    expect(out.mark).toBe('○');
  });

  it('marks a died-but-budget-remains attempt with ✗ (AC-15)', () => {
    const out = railOutcome(row({
      attempts: strip([att({ status: 'failed', iteration: 1, maxIterations: 3 })]),
      latestWorker: { mergedAt: null, prLifecycleStatus: 'ci_failed' },
    }));
    expect(out.state).toBe('failed');
    expect(out.mark).toBe('✗');
    expect(out.tone).toBe('text-status-error');
  });

  it('treats a cancelled final attempt the same as a failed one (Rule D6-5 state 2)', () => {
    const out = railOutcome(row({ attempts: strip([att({ status: 'cancelled' })]) }));
    expect(out.state).toBe('failed');
  });

  it('prints N/N and outranks ✗ when the retry budget is spent (AC-16, Rule D6-6)', () => {
    const out = railOutcome(row({
      attempts: strip([att({ status: 'failed', iteration: 3, maxIterations: 3 })]),
      latestWorker: openWorker,
    }));
    expect(out.state).toBe('exhausted');
    expect(out.mark).toBe('3/3');
    expect(out.tone).toBe('text-status-error');
  });

  it('does not call a merged row exhausted — the loop closed (Rule D6-5 state 1)', () => {
    const out = railOutcome(row({
      attempts: strip([att({ iteration: 3, maxIterations: 3 })]),
      latestWorker: mergedWorker,
      reviewerNote: { type: 'reviewer_approved', status: 'answered' },
    }));
    expect(out.state).toBe('clean');
    expect(out.mark).toBeNull();
  });

  it('reads exhaustion off the NEWEST attempt only', () => {
    const out = railOutcome(row({
      attempts: strip([att({ iteration: 3, maxIterations: 3 }), att({ iteration: 1, maxIterations: 3 })]),
      latestWorker: openWorker,
    }));
    expect(out.state).toBe('clean');
  });

  it('falls through to the next state rather than guessing when the counters are absent (Rule D6-10)', () => {
    const out = railOutcome(row({
      attempts: strip([att({ status: 'failed', iteration: null, maxIterations: null })]),
      latestWorker: openWorker,
    }));
    expect(out.state).toBe('failed');
    expect(out.mark).toBe('✗');
  });

  it('still marks a row that has attempts but no PR at all (AC-23, Rule D6-13)', () => {
    const out = railOutcome(row({
      attempts: strip([att(), att({ status: 'running', settled: false })]),
      latestWorker: null,
    }));
    expect(out.mark).toBe('●○');
    expect(out.hasAttempts).toBe(true);
  });
});

describe('rollupRailOutcome — one mark per collapsed chain (Rule D7-5)', () => {
  const clean = { state: 'clean', mark: null, tone: null, hasAttempts: true } as const;
  const unlanded = { state: 'unlanded', mark: '!', tone: 'text-status-warning', hasAttempts: true } as const;
  const failed = { state: 'failed', mark: '✗', tone: 'text-status-error', hasAttempts: true } as const;
  const exhausted = { state: 'exhausted', mark: '3/3', tone: 'text-status-error', hasAttempts: true } as const;

  it('wears the worst outcome in the chain (AC-20)', () => {
    expect(rollupRailOutcome([clean, unlanded, clean]).mark).toBe('!');
  });

  it('orders exhausted above failed above live above unlanded (Rule D6-6)', () => {
    expect(rollupRailOutcome([unlanded, failed]).state).toBe('failed');
    expect(rollupRailOutcome([failed, exhausted]).state).toBe('exhausted');
  });

  it('stays silent when every member came out clean', () => {
    expect(rollupRailOutcome([clean, clean]).mark).toBeNull();
  });

  it('carries a chevron when any member has history, and none when no member does', () => {
    expect(rollupRailOutcome([clean, { ...clean, hasAttempts: false }]).hasAttempts).toBe(true);
    expect(rollupRailOutcome([{ ...clean, hasAttempts: false }]).hasAttempts).toBe(false);
  });

  it('is clean-and-silent for an empty chain rather than throwing', () => {
    expect(rollupRailOutcome([]).state).toBe('clean');
  });
});
