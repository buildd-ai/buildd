import { describe, expect, it } from 'bun:test';
import { computeMissionFlightStrip as compute, FLIGHT_STRIP_IDLE_THRESHOLD_MS as GAP, FLIGHT_STRIP_ORCHESTRATOR_MARK_CAP as MARKS, FLIGHT_STRIP_BAR_CAP as BARS } from '../mission-helpers';

const date = (ms: number) => new Date(ms);
const task = { id: 'task', status: 'completed' };
const worker = (id: string, start: number, end: number) => ({ id, taskId: task.id, status: 'completed', startedAt: date(start), completedAt: date(end) });

describe('computeMissionFlightStrip', () => {
  it('renders all-unlabelled missions as ONE uncaptioned track, never build', () => {
    const strip = compute([task], [worker('one', 0, 100)]);
    expect(strip.lanes).toEqual([null]);
    expect(strip.hasLaneData).toBe(false);
    expect(strip.bars[0].lane).toBeNull();
  });
  it('uses the work-kind lane adapter and preserves unknowns in partially labelled missions', () => {
    // Rule L-1: role builder → engineering → BUILD. The retired lane chain
    // chain read `taskClass === 'attempt'` first and said CHECK (Rule L-4).
    const strip = compute([{ ...task, taskClass: 'attempt', roleSlug: 'builder' }, { id: 'unknown', status: 'pending' }], [worker('one', 0, 100)]);
    expect(strip.lanes).toEqual(['think', 'build', 'check']);
    expect(strip.bars.map(b => b.lane)).toEqual(['build', null]);
  });
  // AC-8: the elision threshold is normative at 15 minutes (Rule X-2), not just
  // "whatever the constant currently says" — a literal-minutes test so a future
  // change to FLIGHT_STRIP_IDLE_THRESHOLD_MS can't silently drift from the spec
  // the way packages/core/__tests__/mission-helpers.test.ts:784 once let the
  // status==='error' bug survive by asserting the code's own behavior back at it.
  it('AC-8: merges a 14-minute gap silently but elides a 15-minute gap with a break glyph', () => {
    const FOURTEEN_MIN = 14 * 60_000;
    const FIFTEEN_MIN = 15 * 60_000;
    const merged = compute([task], [worker('a', 0, 100), worker('b', 100 + FOURTEEN_MIN, 300 + FOURTEEN_MIN)]);
    expect(merged.phases).toHaveLength(1);
    expect(merged.durationMs).toBe(300 + FOURTEEN_MIN);

    const elided = compute([task], [worker('a', 0, 100), worker('b', 100 + FIFTEEN_MIN, 300 + FIFTEEN_MIN)]);
    expect(elided.phases).toHaveLength(2);
    expect(elided.durationMs).toBe(300);
  });

  it('elides threshold-sized gaps and derives phases from exactly those boundaries', () => {
    const strip = compute([task], [worker('a', 0, 100), worker('b', 100 + GAP, 300 + GAP)]);
    expect(strip.durationMs).toBe(300);
    expect(strip.bars.map(b => [b.start, b.end])).toEqual([[0, 1 / 3], [1 / 3, 1]]);
    expect(strip.phases).toEqual([{ label: 'P1', position: 0, idleMs: 0 }, { label: 'P2', position: 1 / 3, idleMs: GAP }]);
  });
  it('retains short gaps to scale and respects overlapping spans', () => {
    const strip = compute([task], [worker('a', 0, GAP), worker('b', 10, 20), worker('c', GAP + 10, GAP + 20)]);
    expect(strip.durationMs).toBe(GAP + 20);
    expect(strip.phases).toHaveLength(1);
  });
  it('buckets peak overlapping concurrency as 1/2/3+, with ends before starts', () => {
    const strip = compute([task], [worker('a', 0, 10), worker('b', 10, 30), worker('c', 20, 30), worker('d', 40, 60), worker('e', 45, 60), worker('f', 50, 60), worker('g', 55, 60)]);
    expect(strip.bars.map(b => b.concurrency)).toEqual([1, 2, 2, 3, 3, 3, 3]);
    expect(strip.peakConcurrency).toBe(4);
  });
  for (const cause of ['code_failure', 'infra_failure', 'budget_limited', 'condition_unmet', 'never_started', 'silent_start', 'reassigned', 'sandbox_mount_gap', 'needs_input', null]) {
    it(`classifies exitCause=${cause} independently of status`, () => {
      for (const status of ['failed', 'completed']) {
        const strip = compute([task], [{ ...worker('one', 0, 100), status, exitCause: cause }]);
        expect(strip.bars[0].fill).toBe(cause === 'code_failure' || cause === 'infra_failure' ? 'failure' : 'concurrency');
      }
    });
  }
  it('extends live spans to now and renders queued tasks hollow/dashed without invented duration', () => {
    const strip = compute([{ ...task, status: 'running' }, { id: 'queued', status: 'pending' }], [{ ...worker('one', 0, 10), status: 'running', completedAt: null, updatedAt: date(10) }], { now: 100 });
    expect(strip.durationMs).toBe(100);
    expect(strip.now).toBe(1);
    expect(strip.bars[1]).toMatchObject({ start: 1, end: 1, fill: 'none', dashed: true, concurrency: 0 });
    expect(compute([task], [worker('one', 0, 100)], { missionCompletedAt: date(100) }).now).toBeNull();
  });
  it('handles empty, queued-only, invalid and orphan spans with finite coordinates', () => {
    expect(compute([], []).bars).toEqual([]);
    const strip = compute([{ ...task, status: 'pending' }], [{ ...worker('bad', 0, 100), startedAt: 'invalid' }, { ...worker('orphan', 0, 100), taskId: 'missing' }], { now: 100 });
    expect(strip.bars).toHaveLength(1);
    expect(strip.bars[0]).toMatchObject({ start: 0, end: 0, fill: 'none' });
  });
  it('rejects reversed and zero spans and uses updatedAt only for terminal workers', () => {
    const strip = compute([task], [worker('zero', 5, 5), worker('reversed', 10, 0), {
      ...worker('terminal', 0, 100), completedAt: null, updatedAt: date(50),
    }], { now: 100 });
    expect(strip.bars).toHaveLength(1);
    expect(strip.durationMs).toBe(50);
  });
  it('collapses an empty steering rail and clusters excess model cycles into one counted glyph', () => {
    expect(compute([task], []).rail.visible).toBe(false);
    const steeringEvents = Array.from({ length: MARKS + 3 }, (_, i) => ({ id: `cycle-${i}`, kind: 'orchestrator' as const, at: date(i) }));
    const strip = compute([task], [worker('one', 0, 100)], { steeringEvents: [...steeringEvents, { id: 'note', kind: 'human', at: date(50) }] });
    expect(strip.rail.visible).toBe(true);
    expect(strip.rail.marks.filter(m => m.kind === 'orchestrator')).toHaveLength(MARKS);
    expect(strip.rail.marks.find(m => m.count > 1)?.count).toBe(4);
    expect(strip.rail.marks.find(m => m.id === 'note')?.position).toBe(0.5);
  });
  it('maps idle steering events to phase boundaries and derives P3 from the next gap', () => {
    const strip = compute([task], [worker('a', 0, 100), worker('b', GAP + 100, GAP + 200), worker('c', 2 * GAP + 200, 2 * GAP + 300)], {
      steeringEvents: [{ id: 'instruction', kind: 'human', at: date(200) }],
    });
    expect(strip.phases.map(p => p.label)).toEqual(['P1', 'P2', 'P3']);
    expect(strip.rail.marks[0].position).toBe(1 / 3);
    expect(strip.phases[2].position).toBe(2 / 3);
  });
  it('shows a queued retry after a historical run and folds queued-only missions', () => {
    const strip = compute([{ ...task, status: 'pending' }], [worker('old', 0, 100)], { now: 200 });
    expect(strip.bars.map(b => b.fill)).toEqual(['concurrency', 'none']);
    const queued = compute(Array.from({ length: BARS + 2 }, (_, i) => ({ id: `task-${i}`, status: 'pending' })), []);
    expect(queued.bars).toHaveLength(BARS);
    expect(queued.foldedBars).toBe(2);
    expect(queued.peakConcurrency).toBe(0);
  });
  it('folds bars without changing the domain or peak concurrency', () => {
    const strip = compute([task], Array.from({ length: BARS + 3 }, (_, i) => worker(`w-${i}`, 0, 100)));
    expect(strip.bars).toHaveLength(BARS);
    expect(strip.foldedBars).toBe(3);
    expect(strip.peakConcurrency).toBe(BARS + 3);
    expect(strip.durationMs).toBe(100);
  });
  it('keeps a live worker and the most recent history visible when folding beyond the bar cap, dropping the oldest instead', () => {
    const historical = Array.from({ length: BARS }, (_, i) => worker(`old-${i}`, i * 10, i * 10 + 5));
    const live = { ...worker('newest', BARS * 10, BARS * 10 + 5), status: 'running', completedAt: null, updatedAt: date(BARS * 10 + 5) };
    const strip = compute([{ ...task, status: 'running' }], [...historical, live], { now: BARS * 10 + 20 });
    expect(strip.bars).toHaveLength(BARS);
    expect(strip.foldedBars).toBe(1);
    expect(strip.bars.some(b => b.workerId === 'newest')).toBe(true);
    expect(strip.bars.some(b => b.workerId === 'old-0')).toBe(false);
  });

  // §6: agentTimeMin/axisSpanMin/parallelFactor — the direct replacement for
  // the retired computeMissionSkyline's agentTimeMin/activeSpanMin/parallelFactor.
  it('agentTimeMin sums raw span durations, axisSpanMin is their idle-elided union', () => {
    const strip = compute([task], [worker('a', 0, 30 * 60_000), worker('b', 0, 30 * 60_000)]);
    expect(strip.agentTimeMin).toBeCloseTo(60, 1);
    expect(strip.axisSpanMin).toBeCloseTo(30, 1);
    expect(strip.parallelFactor).toBeCloseTo(2.0, 1);
  });

  it('Rule L-3: a schedule/orchestrator planning tick does not count toward agentTimeMin or axisSpanMin', () => {
    const tick = { id: 'tick', status: 'completed', creationSource: 'schedule', mode: 'planning' };
    const strip = compute(
      [task, tick],
      [worker('a', 0, 30 * 60_000), { ...worker('tick-worker', 0, 500 * 60_000), taskId: 'tick' }],
    );
    expect(strip.agentTimeMin).toBeCloseTo(30, 1);
    expect(strip.axisSpanMin).toBeCloseTo(30, 1);
    expect(strip.parallelFactor).toBeCloseTo(1.0, 1);
  });

  it('Rule L-3 does not catch a human-filed coordination task sharing mode=planning', () => {
    const humanCoord = { id: 'human', status: 'completed', creationSource: 'dashboard', mode: 'planning' };
    const strip = compute(
      [task, humanCoord],
      [worker('a', 0, 30 * 60_000), { ...worker('h', 0, 30 * 60_000), taskId: 'human' }],
    );
    expect(strip.agentTimeMin).toBeCloseTo(60, 1);
  });
});
