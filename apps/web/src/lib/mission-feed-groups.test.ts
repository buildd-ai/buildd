import { describe, expect, it } from 'bun:test';
import { buildMissionFeedGroups, NEEDS_YOU_VISIBLE_CAP, FUTURE_PHASE_VISIBLE_CAP, type FeedGroup } from './mission-feed-groups';
import { buildPulseSegments, pulseDoneCounts, type MissionFeedTaskInput } from './mission-pulse';

// Illustrative fixtures only — no real mission or task data.
let clock = Date.UTC(2026, 0, 1);
function t(id: string, over: Partial<MissionFeedTaskInput> = {}): MissionFeedTaskInput {
  clock += 60_000;
  return { id, title: `Task ${id}`, status: 'pending', taskClass: 'work', createdAt: new Date(clock), ...over };
}
const THINK = { missionPhaseIndex: 0, missionPhaseLabel: 'THINK' };
const BUILD = { missionPhaseIndex: 1, missionPhaseLabel: 'BUILD' };
const CHECK = { missionPhaseIndex: 2, missionPhaseLabel: 'CHECK' };
const running = { status: 'in_progress', worker: { status: 'running' } } as const;
const asking = { status: 'in_progress', worker: { status: 'waiting_input' } } as const;

function rowIds(groups: FeedGroup[]): string[] {
  return groups.flatMap(g => (g.kind === 'phase' ? g.items.filter(i => i.type === 'row').map(i => (i as any).row.taskId) : g.rows.map(r => r.taskId)));
}
function slotIds(groups: FeedGroup[]): string[] {
  return groups.flatMap(g => (g.kind === 'phase' ? g.items.filter(i => i.type === 'slot').map(i => (i as any).taskId) : []));
}
const phaseGroups = (groups: FeedGroup[]) => groups.filter((g): g is Extract<FeedGroup, { kind: 'phase' }> => g.kind === 'phase');

/** A 15-task mission across three phases, the shape the design's wireframes use. */
function fifteen(): MissionFeedTaskInput[] {
  return [
    t('th1', { ...THINK, status: 'completed' }), t('th2', { ...THINK, status: 'completed' }),
    t('th3', { ...THINK, status: 'completed' }), t('th4', { ...THINK, status: 'completed' }),
    t('b1', { ...BUILD, status: 'completed' }), t('b2', { ...BUILD, ...asking }),
    t('b3', { ...BUILD, ...running }), t('b4', { ...BUILD, ...running }),
    t('b5', { ...BUILD, dependsOn: ['b2'] }), t('b6', { ...BUILD }),
    t('c1', { ...CHECK }), t('c2', { ...CHECK }), t('c3', { ...CHECK }), t('c4', { ...CHECK }), t('c5', { ...CHECK }),
  ];
}

describe('buildMissionFeedGroups — L-1: every work task is a row exactly once', () => {
  it('pinned rows appear once, and their phase gets a slot marker instead of a second row (AC-3)', () => {
    const { groups } = buildMissionFeedGroups(fifteen());
    const ids = rowIds(groups);
    expect(ids.sort()).toEqual(fifteen().map(x => x.id).sort().map(id => id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(slotIds(groups).sort()).toEqual(['b2', 'b3', 'b4']);
  });

  it('group order: NEEDS YOU, MOVING NOW, then phases in phase order', () => {
    const { groups } = buildMissionFeedGroups(fifteen());
    expect(groups.map(g => (g.kind === 'phase' ? `phase:${g.label}` : g.kind))).toEqual([
      'needs_you', 'moving', 'phase:THINK', 'phase:BUILD', 'phase:CHECK',
    ]);
  });

  it('omits empty pinned groups', () => {
    const { groups } = buildMissionFeedGroups([t('a', THINK), t('b', BUILD)]);
    expect(groups.map(g => g.kind)).toEqual(['phase', 'phase']);
  });

  it('retries and cancelled re-creations never become rows; N counts deliverable rows (D1)', () => {
    const model = buildMissionFeedGroups([
      t('x1', { title: 'Lease shadow mode', status: 'cancelled' }),
      t('x2', { title: 'Lease shadow mode', status: 'completed' }),
      t('r', { taskClass: 'attempt', parentTaskId: 'x2', status: 'completed' }),
      t('y'),
    ]);
    expect(rowIds(model.groups).sort()).toEqual(['x2', 'y']);
    expect(model.order).toEqual(['x2', 'y']);
    expect(model.rowsById.get('x2')!.attempts.map(a => a.id)).toEqual(['x1', 'r']);
    expect(model.rowsById.get('x2')!.position.total).toBe(2);
  });

  it('bookkeeping and orchestrator rows are counted, never rendered as rows', () => {
    const model = buildMissionFeedGroups([t('plan', { taskClass: 'bookkeeping', mode: 'planning' }), t('w')]);
    expect(rowIds(model.groups)).toEqual(['w']);
    expect(model.bookkeeping.map(b => b.id)).toEqual(['plan']);
  });
});

describe('NEEDS YOU', () => {
  it('collects input, questions, decisions, PRs awaiting merge, and failures with no retry — oldest ask first', () => {
    const base = Date.UTC(2026, 0, 2);
    const model = buildMissionFeedGroups(
      [
        t('pr', { status: 'completed', updatedAt: new Date(base + 5_000), worker: { status: 'completed', prNumber: 3 } }),
        t('in', { status: 'in_progress', worker: { status: 'waiting_input', updatedAt: new Date(base + 1_000) } }),
        t('q', { status: 'completed', worker: { status: 'completed' } }),
        t('dec', {}),
        t('f', { status: 'failed', updatedAt: new Date(base + 2_000) }),
        t('ok', { status: 'completed' }),
      ],
      { openQuestions: new Map([['q', new Date(base + 4_000)]]), openDecisions: new Map([['dec', new Date(base + 3_000)]]) },
    );
    const needs = model.groups.find(g => g.kind === 'needs_you')!;
    expect(needs.kind === 'needs_you' && needs.rows.map(r => [r.taskId, r.needsYou])).toEqual([
      ['in', 'input'], ['f', 'failed'], ['dec', 'decision'], ['q', 'question'], ['pr', 'pr'],
    ]);
  });

  it(`shows at most ${NEEDS_YOU_VISIBLE_CAP} rows, then +N more`, () => {
    const model = buildMissionFeedGroups(Array.from({ length: 5 }, (_, i) => t(`n${i}`, asking)));
    const needs = model.groups[0];
    expect(needs.kind).toBe('needs_you');
    if (needs.kind !== 'needs_you') return;
    expect(needs.rows).toHaveLength(5);
    expect(needs.visibleLimit).toBe(NEEDS_YOU_VISIBLE_CAP);
    expect(needs.hiddenCount).toBe(2);
  });
});

describe('MOVING NOW', () => {
  it('holds claimed/starting/running rows, by start time', () => {
    const base = Date.UTC(2026, 0, 3);
    const model = buildMissionFeedGroups([
      t('late', { status: 'in_progress', worker: { status: 'running', startedAt: new Date(base + 9_000) } }),
      t('early', { status: 'in_progress', worker: { status: 'running', startedAt: new Date(base + 1_000) } }),
      t('claimed', { status: 'assigned' }),
    ]);
    const moving = model.groups.find(g => g.kind === 'moving')!;
    expect(moving.kind === 'moving' && moving.rows.map(r => r.taskId)).toEqual(['early', 'late', 'claimed']);
  });
});

describe('phase fold defaults', () => {
  it('finished folds, the first unfinished is current and expanded, later ones show 3 then +N queued', () => {
    const [think, build, check] = phaseGroups(buildMissionFeedGroups(fifteen()).groups);
    expect(think).toMatchObject({ status: 'finished', collapsed: true, done: 4, total: 4, ordinal: 1 });
    expect(build).toMatchObject({ status: 'current', collapsed: false, visibleLimit: null, done: 1, total: 6, ordinal: 2 });
    expect(check).toMatchObject({ status: 'future', collapsed: false, visibleLimit: FUTURE_PHASE_VISIBLE_CAP, hiddenCount: 2 });
  });

  it('a completed mission folds every phase, cancelled re-creations and all, and pins nothing', () => {
    const tasks = [
      ...fifteen().map(x => ({ ...x, status: 'completed', worker: null })),
      t('x1', { ...BUILD, title: 'Task b6', status: 'cancelled' }),
      t('b6-retry', { taskClass: 'attempt', parentTaskId: 'b6', status: 'failed' }),
    ];
    const { groups } = buildMissionFeedGroups(tasks);
    expect(groups.some(g => g.kind !== 'phase')).toBe(false);
    for (const g of phaseGroups(groups)) expect(g).toMatchObject({ status: 'finished', collapsed: true });
  });

  it('an unphased mission is one group, finished and folded once every row is done', () => {
    const [open] = phaseGroups(buildMissionFeedGroups([t('u1', { status: 'completed' }), t('u2')]).groups);
    expect(open).toMatchObject({ label: null, status: 'current', collapsed: false });
    const [done] = phaseGroups(buildMissionFeedGroups([t('u1', { status: 'completed' }), t('u2', { status: 'cancelled' })]).groups);
    // F3: a cancelled row is finished but not counted — done/total read 1/1, like the pulse.
    expect(done).toMatchObject({ label: null, status: 'finished', collapsed: true, done: 1, total: 1 });
  });

  it('F3: a phase header counts like the pulse — cancelled rows are listed, never in done/total', () => {
    const tasks = [
      t('a', { ...BUILD, status: 'completed' }),
      t('b', { ...BUILD, status: 'cancelled' }),
      t('c', { ...BUILD }),
    ];
    const [build] = phaseGroups(buildMissionFeedGroups(tasks).groups);
    expect(build).toMatchObject({ done: 1, total: 2 });
    expect(build.items).toHaveLength(3);
    expect(pulseDoneCounts(buildPulseSegments(tasks))).toEqual({ done: build.done, total: build.total });
  });

  it('within a phase: failed, queued-ready, queued-blocked ("after #x"), done — a pinned task leaves its slot at its own place (rule 4)', () => {
    const model = buildMissionFeedGroups([
      t('done', { ...BUILD, status: 'completed' }),
      t('blocked', { ...BUILD, dependsOn: ['ask'] }),
      t('ready', { ...BUILD }),
      t('ask', { ...BUILD, ...asking }),
      t('retrying', { ...BUILD, status: 'failed' }),
      t('fix', { taskClass: 'attempt', parentTaskId: 'retrying' }),
    ]);
    const [build] = phaseGroups(model.groups);
    expect(build.items.map(i => (i.type === 'slot' ? `slot:${i.taskId}` : i.row.taskId))).toEqual([
      'retrying', 'ready', 'slot:ask', 'blocked', 'done',
    ]);
    const blocked = build.items.find(i => i.type === 'row' && i.row.taskId === 'blocked');
    expect(blocked?.type === 'row' && blocked.row.blockedByTaskId).toBe('ask');
  });

  it('a half-set phase (label without index, or index without label) is unphased — index and label agree', () => {
    const { groups } = buildMissionFeedGroups([
      t('h1', { missionPhaseIndex: null, missionPhaseLabel: 'THINK' }),
      t('h2', { missionPhaseIndex: 3, missionPhaseLabel: null }),
    ]);
    for (const g of phaseGroups(groups)) expect([g.index, g.label]).toEqual([null, null]);
  });

  it('an unphased mission is one current group with no label', () => {
    const groups = phaseGroups(buildMissionFeedGroups([t('a'), t('b')]).groups);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ index: null, label: null, status: 'current' });
  });
});

describe('numbering and stepping follow pulse order', () => {
  it('n / N and prev/next equal the pulse order; pinning does not renumber', () => {
    const tasks = fifteen();
    const model = buildMissionFeedGroups(tasks);
    expect(model.order).toEqual(buildPulseSegments(tasks).map(s => s.taskId));
    const b2 = model.rowsById.get('b2')!;
    expect(b2.position).toMatchObject({ n: 6, total: 15, phaseLabel: 'BUILD', prevTaskId: 'b1', nextTaskId: 'b3' });
    expect(model.rowsById.get('th1')!.position.prevTaskId).toBeNull();
    expect(model.rowsById.get('c5')!.position.nextTaskId).toBeNull();
  });

  it('nextNeedingYou crosses into NEEDS YOU order and wraps, excluding the current task', () => {
    const model = buildMissionFeedGroups([t('a', asking), t('b'), t('c', asking)]);
    expect(model.nextNeedingYou('b')).toBe('a');
    expect(model.nextNeedingYou('a')).toBe('c');
    expect(model.nextNeedingYou('c')).toBe('a');
    const lonely = buildMissionFeedGroups([t('a', asking), t('b')]);
    expect(lonely.nextNeedingYou('a')).toBeNull();
    expect(lonely.nextNeedingYou(null)).toBe('a');
  });
});

describe('scale', () => {
  it('a 45-task mission still renders every row once', () => {
    const tasks = Array.from({ length: 45 }, (_, i) => t(`s${i}`, { ...[THINK, BUILD, CHECK][i % 3], status: i < 10 ? 'completed' : 'pending' }));
    const ids = rowIds(buildMissionFeedGroups(tasks).groups);
    expect(ids).toHaveLength(45);
    expect(new Set(ids).size).toBe(45);
  });
});
