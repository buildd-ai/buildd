import { describe, expect, it } from 'bun:test';
import {
  buildMissionBoard,
  concurrencyBins,
  formatAge,
  formatClock,
  selectMilestones,
  toBoardTaskInput,
  type BoardTaskInput,
  type BoardWorkerInput,
  type MissionBoardInput,
} from './mission-board';
import { boardTaskLabel } from './mission-board-label';
import { taskDisplayLabel } from '@buildd/core/task-label';

// Illustrative fixtures only — no real mission or task data.
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const min = (n: number) => T0 + n * 60_000;

function worker(over: Partial<BoardWorkerInput> = {}): BoardWorkerInput {
  return {
    id: `w-${Math.random().toString(36).slice(2, 8)}`,
    status: 'running',
    runner: 'atlas',
    startedAt: min(1),
    completedAt: null,
    updatedAt: min(2),
    mergedAt: null,
    prNumber: null,
    prUrl: null,
    prLifecycleStatus: null,
    currentAction: null,
    waitingFor: null,
    milestones: [],
    linesAdded: null,
    linesRemoved: null,
    ...over,
  };
}

let created = T0;
function task(id: string, over: Partial<BoardTaskInput> = {}): BoardTaskInput {
  created += 1000;
  const workers = over.workers ?? [];
  const w = workers[0];
  return {
    id,
    title: `feat(${id}): do the ${id} thing`,
    status: 'pending',
    taskClass: 'work',
    createdAt: new Date(created),
    missionPhaseIndex: 1,
    missionPhaseLabel: 'Foundations',
    roleSlug: 'builder',
    workers,
    worker: w
      ? {
          status: w.status,
          startedAt: w.startedAt ? new Date(w.startedAt) : null,
          updatedAt: w.updatedAt ? new Date(w.updatedAt) : null,
          prNumber: w.prNumber,
          prUrl: w.prUrl,
          prLifecycleStatus: w.prLifecycleStatus,
          mergedAt: w.mergedAt ? new Date(w.mergedAt) : null,
        }
      : null,
    ...over,
  };
}

function board(tasks: BoardTaskInput[], over: Partial<MissionBoardInput> = {}) {
  return buildMissionBoard({
    tasks,
    now: min(12),
    missionCreatedAt: T0,
    missionStatus: 'active',
    roles: [{ slug: 'builder', name: 'Builder', color: 'var(--test-role)' }],
    ...over,
  });
}

describe('buildMissionBoard — before the plan lands', () => {
  // Regression: with only the orchestrator's planning task, the Board drew one
  // empty "1 TASKS 0/0" column. No deliverables means no columns; the model
  // carries the planning task's live state for a placeholder instead.
  const plan = task('plan', {
    title: 'Mission: Example goal', taskClass: 'bookkeeping', mode: 'planning', status: 'in_progress', roleSlug: 'organizer',
    missionPhaseIndex: null, missionPhaseLabel: null,
    workers: [worker({ runner: 'atlas', startedAt: min(0), currentAction: 'Reading the schema', milestones: [{ ts: min(1), label: 'Mapped the invoice tables' }] })],
  });
  const m = board([plan], { roles: [{ slug: 'organizer', name: 'Organizer', color: 'var(--test-role)' }] });

  it('draws no phase columns', () => {
    expect(m.phases).toEqual([]);
  });

  it('exposes the planning task and its live worker state', () => {
    expect(m.planning).toMatchObject({
      taskId: 'plan', roleName: 'Organizer', live: true, runner: 'atlas',
      startedAt: min(0), currentAction: 'Reading the schema', lastMilestone: 'Mapped the invoice tables',
    });
  });

  it('drops the placeholder once deliverables exist', () => {
    const withWork = board([plan, task('db')], { roles: [{ slug: 'organizer', name: 'Organizer', color: 'var(--test-role)' }] });
    expect(withWork.planning).toBeNull();
    expect(withWork.phases.length).toBe(1);
  });
});

describe('buildMissionBoard — tile states', () => {
  it('refines the feed state into what a tile draws', () => {
    const merged = task('db', { status: 'completed', workers: [worker({ status: 'completed', completedAt: min(5), prNumber: 11, mergedAt: min(6), prLifecycleStatus: 'merged' })] });
    const running = task('api', { status: 'in_progress', dependsOn: ['db'], workers: [worker({ runner: 'birch' })] });
    const review = task('fx', { status: 'completed', workers: [worker({ status: 'completed', completedAt: min(8), prNumber: 13, prLifecycleStatus: 'ci_running' })] });
    const waiting = task('pay', { status: 'in_progress', workers: [worker({ status: 'waiting_input', updatedAt: min(11), waitingFor: { prompt: 'Per line or total?', options: ['Per line', 'Total'] } })] });
    const blocked = task('e2e', { dependsOn: ['api'] });
    const ready = task('docs', { dependsOn: ['db'] });
    const m = board([merged, running, review, waiting, blocked, ready]);
    expect(m.tasks.db.status).toBe('merged');
    expect(m.tasks.api.status).toBe('running');
    expect(m.tasks.fx.status).toBe('review');
    expect(m.tasks.pay.status).toBe('waiting');
    expect(m.tasks.e2e.status).toBe('blocked');
    expect(m.tasks.docs.status).toBe('ready');
    expect(m.needsYou).toEqual(['pay']);
    expect(m.tasks.pay.waitingFor?.options).toEqual(['Per line', 'Total']);
    expect(m.tasks.pay.waitStartedAt).toBe(min(11));
    expect(m.inReview).toEqual(['fx']);
    expect(m.upNext).toEqual(['e2e', 'docs']);
    expect(m.landed).toEqual({ done: 1, total: 6 });
  });

  it('a red PR with a live fix attempt is fixing, drawn on the fix worker', () => {
    const parent = task('inv', { status: 'completed', workers: [worker({ status: 'completed', completedAt: min(6), prNumber: 16, prLifecycleStatus: 'ci_failed' })] });
    const fix = task('inv-fix', {
      title: '[builder · after CI #1] feat(inv): do the inv thing',
      taskClass: 'attempt', parentTaskId: 'inv', status: 'in_progress', ciRetryPrNumber: 16,
      createdAt: new Date(min(7)),
      workers: [worker({ runner: 'birch', startedAt: min(7) })],
    });
    const m = board([parent, fix]);
    expect(Object.keys(m.tasks)).toEqual(['inv']);
    expect(m.tasks.inv.status).toBe('fixing');
    expect(m.tasks.inv.runner).toBe('birch');
    expect(m.tasks.inv.attempt).toBe(2);
    expect(m.ciFails).toEqual([{ at: min(7), pr: 16, taskId: 'inv' }]);
    const fixBar = m.bars.find(b => b.retry)!;
    expect(fixBar.label).toBe('CI fix');
    expect(fixBar.scope).toBe('inv');
    expect(fixBar.taskId).toBe('inv');
  });

  it('reads the role colour from the role data', () => {
    const m = board([task('a')]);
    expect(m.tasks.a.roleColor).toBe('var(--test-role)');
    expect(m.tasks.a.roleName).toBe('Builder');
  });

  it('groups tasks into phase columns with done counts', () => {
    const a = task('a', { status: 'completed', workers: [worker({ status: 'completed', completedAt: min(3) })] });
    const b = task('b', { missionPhaseIndex: 2, missionPhaseLabel: 'Through the product' });
    const m = board([a, b]);
    expect(m.phases.map(p => [p.ordinal, p.label, p.done, p.total])).toEqual([
      [1, 'Foundations', 1, 1],
      [2, 'Through the product', 0, 1],
    ]);
  });
});

describe('buildMissionBoard — fleet and lanes', () => {
  it('derives runner slots from overlap and reports live occupancy', () => {
    const a = task('a', { status: 'in_progress', workers: [worker({ runner: 'atlas', startedAt: min(1) })] });
    const b = task('b', { status: 'in_progress', workers: [worker({ runner: 'atlas', startedAt: min(2), status: 'waiting_input' })] });
    const c = task('c', { status: 'completed', workers: [worker({ runner: 'birch', startedAt: min(1), completedAt: min(3), status: 'completed' })] });
    const m = board([a, b, c]);
    const atlas = m.runners.find(r => r.name === 'atlas')!;
    expect(atlas.capacity).toBe(2);
    expect(atlas.slots).toEqual([{ taskId: 'a', waiting: false }, { taskId: 'b', waiting: true }]);
    expect(m.runners.find(r => r.name === 'birch')!.slots).toEqual([null]);
    expect(m.live).toBe(2);
    expect(m.capacity).toBe(3);
    expect(m.tasks.b.slot).toBe(1);
  });

  it('divides live by the FLEET capacity when it is known, not by the slots this mission drew', () => {
    // Regression: Lanes read "LIVE 5 /5 slots" while Home said 5/8 — the
    // denominator was the overlap-derived slot count of this mission's bars.
    const a = task('a', { status: 'in_progress', workers: [worker({ runner: 'atlas', startedAt: min(1) })] });
    const b = task('b', { status: 'in_progress', workers: [worker({ runner: 'birch', startedAt: min(1) })] });
    expect(board([a, b]).capacity).toBe(2);
    expect(board([a, b], { fleetCapacity: 8 }).capacity).toBe(8);
    // Never below what is visibly live (a stale heartbeat must not read 5/3).
    expect(board([a, b], { fleetCapacity: 1 }).capacity).toBe(2);
  });

  it('counts a claimed worker that has not started yet in the fleet band, as its tile does', () => {
    // A claim inserts the worker (status idle) before the runner stamps
    // startedAt. The tile already shows it running on its runner; the band
    // must agree rather than read "0 agents · idle".
    const plan = task('plan', { mode: 'planning', status: 'completed', workers: [worker({ runner: 'atlas', startedAt: min(0), completedAt: min(1), status: 'completed' })] });
    const a = task('a', { status: 'assigned', workers: [worker({ runner: 'atlas', status: 'idle', startedAt: null, createdAt: min(1) })] });
    const b = task('b', { status: 'assigned', workers: [worker({ runner: 'birch', status: 'idle', startedAt: null, createdAt: min(1) })] });
    const m = board([plan, a, b], { now: min(1) + 2_000 });
    expect(m.tasks.a.runner).toBe('atlas');
    expect(m.tasks.b.runner).toBe('birch');
    expect(m.live).toBe(2);
    expect(m.runners.map(r => r.name)).toEqual(['atlas', 'birch']);
    expect(m.runners.find(r => r.name === 'birch')!.slots).toEqual([{ taskId: 'b', waiting: false }]);
    expect(m.runners.find(r => r.name === 'atlas')!.slots).toContainEqual({ taskId: 'a', waiting: false });
  });

  it('names a runner that claimed with its URL by host, not by the URL (avatar is not "H")', () => {
    const a = task('a', { status: 'in_progress', workers: [worker({ runner: 'http://atlas.local:8766', startedAt: min(1) })] });
    const m = board([a]);
    expect(m.runners.map(r => [r.name, r.initial])).toEqual([['atlas', 'A']]);
    expect(m.tasks.a.runner).toBe('atlas');
    expect(m.bars[0].runner).toBe('atlas');
    expect(m.ticker.find(e => e.kind === 'claimed')?.text).toMatch(/→ A$/);
  });

  it('prefers the runner heartbeat hostname, joined on account', () => {
    const a = task('a', { status: 'in_progress', workers: [worker({ runner: 'http://localhost:8766', accountId: 'acct-1', startedAt: min(1) })] });
    const m = board([a], {
      runnerHeartbeats: [{ accountId: 'acct-1', localUiUrl: 'http://localhost:8766', environment: { labels: { hostname: 'birch', machine: 'Mac Studio' } } }],
    });
    expect(m.runners[0]).toMatchObject({ name: 'birch', initial: 'B', machine: 'Mac Studio' });
    expect(m.tasks.a.runner).toBe('birch');
  });

  it('two runners on one host stay two lanes', () => {
    const a = task('a', { status: 'in_progress', workers: [worker({ runner: 'http://atlas.local:8766', startedAt: min(1) })] });
    const b = task('b', { status: 'in_progress', workers: [worker({ runner: 'http://atlas.local:8767', startedAt: min(1) })] });
    const m = board([a, b]);
    expect(m.runners).toHaveLength(2);
    expect(new Set(m.bars.map(x => x.runnerId)).size).toBe(2);
  });

  it('marks a merged bar ok and a bar in CI as pending', () => {
    const merged = task('m', { status: 'completed', workers: [worker({ status: 'completed', completedAt: min(4), prNumber: 1, mergedAt: min(5) })] });
    const ci = task('c', { status: 'completed', workers: [worker({ status: 'completed', completedAt: min(4), prNumber: 2, prLifecycleStatus: 'ci_running' })] });
    const m = board([merged, ci]);
    expect(m.bars.find(b => b.taskId === 'm')!.endMark).toBe('ok');
    expect(m.bars.find(b => b.taskId === 'c')!.endMark).toBe('ci');
    expect(m.merges).toEqual([{ at: min(5), pr: 1, taskId: 'm' }]);
  });

  it('draws the orchestrator run as a plan bar, never a tile', () => {
    const plan = task('plan', { title: 'Mission: Example goal', taskClass: 'bookkeeping', mode: 'planning', status: 'completed', workers: [worker({ status: 'completed', startedAt: min(0), completedAt: min(1) })] });
    const m = board([plan, task('a')]);
    expect(m.tasks.plan).toBeUndefined();
    const bar = m.bars.find(b => b.taskId === 'plan')!;
    expect([bar.tone, bar.label, bar.scope, bar.endMark]).toEqual(['plan', 'plan', null, null]);
  });

  it('carries dependency ids on the bar for hover edges', () => {
    const a = task('a', { status: 'completed', workers: [worker({ status: 'completed', completedAt: min(4) })] });
    const b = task('b', { status: 'in_progress', dependsOn: ['a'], workers: [worker({ startedAt: min(5) })] });
    const m = board([a, b]);
    expect(m.bars.find(x => x.taskId === 'b')!.deps).toEqual(['a']);
    expect(m.tasks.a.unblocks.map(u => u.id)).toEqual(['b']);
  });
});

describe('buildMissionBoard — goal criteria with live counts', () => {
  it('counts merged PRs against the PR-bearing tasks, and open tasks', () => {
    const merged = task('a', { outputRequirement: 'pr_required', status: 'completed', workers: [worker({ status: 'completed', completedAt: min(3), prNumber: 1, mergedAt: min(4) })] });
    const research = task('r', { outputRequirement: 'artifact_required', status: 'in_progress', workers: [worker()] });
    const pending = task('b', { outputRequirement: 'pr_required' });
    const m = board([merged, research, pending], {
      criteria: [
        { type: 'all_prs_merged', label: 'every PR merged' },
        { type: 'no_open_tasks' },
        { type: 'command', label: 'suite green' },
        { type: 'artifact_exists', key: 'policy', label: 'policy recorded' },
      ],
      criteriaState: [{ index: 2, verdict: 'PENDING' }],
      artifacts: [{ key: 'policy', type: 'decision' }],
    });
    expect(m.criteria.map(c => [c.label, c.value, c.state])).toEqual([
      ['PRs merged', '1/2', 'partial'],
      ['open tasks', '2 open', 'partial'],
      ['suite green', 'running', 'running'],
      ['policy recorded', 'recorded', 'pass'],
    ]);
    expect(m.criteria[0].frac).toBe(0.5);
    expect(m.criteriaPassed).toBe(1);
  });
});

describe('buildMissionBoard — ticker, clock and record', () => {
  it('lists the newest events first, capped', () => {
    const a = task('a', { status: 'completed', workers: [worker({ status: 'completed', startedAt: min(1), completedAt: min(4), prNumber: 7, mergedAt: min(5) })] });
    const b = task('b', { status: 'in_progress', workers: [worker({ runner: 'dune', startedAt: min(9) })] });
    const m = board([a, b]);
    expect(m.ticker.map(e => e.text)).toEqual(['b → D', '#7 a merged', '#7 a PR', 'a → A']);
  });

  it('says T+ while running and took once complete', () => {
    const running = board([task('a')]);
    expect(running.clockPrefix).toBe('T+');
    expect(running.clockLabel).toBe('12:00');
    const done = board([task('a', { status: 'completed', workers: [worker({ status: 'completed', completedAt: min(30), linesAdded: 120, linesRemoved: 4, prNumber: 3, mergedAt: min(31) })] })], {
      missionStatus: 'completed', missionCompletedAt: min(37), now: min(60), humanTouches: [min(14)],
    });
    expect(done.complete).toBe(true);
    expect(done.clockPrefix).toBe('took');
    expect(done.clockLabel).toBe('37:00');
    expect(done.record).toMatchObject({ prsMerged: 1, linesAdded: 120, linesRemoved: 4, decisions: 1, peakAgents: 1, runners: 1 });
  });
});

describe('helpers', () => {
  it('keeps only status milestones, in time order', () => {
    expect(selectMilestones([
      { type: 'checkpoint', event: 'first_edit', label: 'First edit', ts: 5 },
      { type: 'status', label: 'b', ts: 9 },
      { type: 'status', label: 'a', ts: 3 },
      { label: 'legacy', timestamp: 4 },
      null,
    ])).toEqual([{ ts: 3, label: 'a' }, { ts: 4, label: 'legacy' }, { ts: 9, label: 'b' }]);
  });

  it('normalises DB rows', () => {
    const t = toBoardTaskInput({
      id: 'x', title: 'feat(x): y', status: 'in_progress', createdAt: new Date(T0).toISOString(),
      workers: [{ id: 'w', status: 'waiting_input', runner: 'atlas', startedAt: new Date(min(1)), waitingFor: { prompt: 'q?', options: [{ label: 'A' }, 'B'] }, milestones: [{ type: 'status', label: 'go', ts: min(2) }] }],
    });
    expect(t.workers[0].startedAt).toBe(min(1));
    expect(t.workers[0].waitingFor).toEqual({ prompt: 'q?', options: ['A', 'B'] });
    expect(t.worker?.status).toBe('waiting_input');
  });

  it('formats clocks and ages', () => {
    expect(formatClock(11 * 60_000 + 50_000)).toBe('11:50');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(formatAge(30_000)).toBe('<1m');
    expect(formatAge(9 * 60_000)).toBe('9m');
  });

  it('bins concurrency', () => {
    expect(concurrencyBins([{ start: 0, end: 10 }, { start: 5, end: null }], 0, 10, 2)).toEqual([1, 2]);
  });

  it('labels a task with the shared short-label helper', () => {
    const t = { title: 'feat(export): accounting CSV carries both currencies' };
    expect(boardTaskLabel(t)).toEqual(taskDisplayLabel(t));
    expect(boardTaskLabel(t).scope).toBe('export');
    expect(boardTaskLabel({ title: 'feat(x): long', label: 'short' }).label).toBe('short');
  });
});
