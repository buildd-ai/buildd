import { describe, expect, it } from 'bun:test';
import { computeFlightStrip, type FlightStripTask } from '../mission-helpers';

const MIN = 60_000;
const epoch = Date.parse('2025-01-01T00:00:00Z');
const at = (min: number) => new Date(epoch + min * MIN).toISOString();
const task = (id: string, start: number, end: number, lane: FlightStripTask['lane'] = 'BUILD'): FlightStripTask => ({
  id, lane, workers: [{ id: `${id}-worker`, startedAt: at(start), completedAt: at(end), status: 'completed' }],
});

describe('computeFlightStrip', () => {
  it('AC-2: keeps unresolved work in UNCLASSIFIED and counts its time', () => {
    const result = computeFlightStrip([task('unknown', 0, 5, null)]);
    expect(result.bars[0].lane).toBe('UNCLASSIFIED');
    expect(result.bars[0].fill).toBe('#6f6a60');
    expect(result.agentTimeMin).toBe(5);
  });

  it('AC-3/11: excludes planning cycles from bars, time, and concurrency, but keeps one rail mark per task', () => {
    const work = task('work', 0, 10);
    const planner = { ...task('planner', 0, 20, 'THINK'), kind: 'coordination', creationSource: 'schedule', mode: 'planning' };
    planner.workers!.push({ ...planner.workers![0], id: 'retry' });
    const result = computeFlightStrip([work, planner]);
    expect(result.bars).toHaveLength(1);
    expect(result.railMarks).toHaveLength(1);
    expect(result.agentTimeMin).toBe(10);
    expect(result.axisSpanMin).toBe(10);
    expect(result.parallelFactor).toBe(1);
    expect(result.peakConcurrency).toBe(1);
    const included = computeFlightStrip([work, { ...planner, creationSource: 'dashboard' }]);
    expect(included.agentTimeMin).toBe(50);
    expect(included.parallelFactor).toBe(2.5);
    expect(included.bars.filter(b => b.lane === 'THINK')).toHaveLength(2);
  });

  it.each(['budget_limited', 'condition_unmet', 'reassigned', 'sandbox_mount_gap', 'needs_input', null])('AC-4: %s is not a failure fill', exitCause => {
    const t = task('interrupted', 0, 10);
    Object.assign(t.workers![0], { status: 'failed', exitCause });
    expect(computeFlightStrip([t]).bars[0].fill).toBe('#4f8a6b');
  });

  it.each(['code_failure', 'infra_failure'])('AC-5: failed + %s receives failure fill', exitCause => {
    const t = task('failed', 0, 10);
    Object.assign(t.workers![0], { status: 'failed', exitCause });
    expect(computeFlightStrip([t]).bars[0].fill).toBe('#d2584b');
    t.workers![0].status = 'completed';
    expect(computeFlightStrip([t]).bars[0].fill).toBe('#4f8a6b');
  });

  it.each(['never_started', 'silent_start'])('omits %s from work metrics', exitCause => {
    const t = task('noop', 0, 10);
    Object.assign(t.workers![0], { exitCause });
    const result = computeFlightStrip([t]);
    expect(result.bars).toEqual([]);
    expect(result.agentTimeMin).toBe(0);
    expect(result.peakConcurrency).toBe(0);
  });

  it('uses raw simultaneous overlap, not count of all workers that overlap a long bar', () => {
    const result = computeFlightStrip([task('long', 0, 10), task('first', 0, 5, 'CHECK'), task('second', 5, 10, 'THINK')]);
    expect(result.bars.map(b => b.concurrencyTier)).toEqual([2, 2, 2]);
    expect(result.peakConcurrency).toBe(2);
    expect(result.agentTimeMin).toBe(20);
    expect(result.axisSpanMin).toBe(10);
    expect(result.parallelFactor).toBe(2);
  });

  it('counts same-lane work in global metrics but only other lanes in the fill tier; packs raw intervals', () => {
    const result = computeFlightStrip([task('a', 0, 10), task('b', 0, 10), task('c', 10, 11)]);
    expect(result.bars.map(b => b.track)).toEqual([0, 1, 0]);
    expect(result.bars.map(b => b.concurrencyTier)).toEqual([1, 1, 1]);
    expect(result.peakConcurrency).toBe(2);
  });

  it('counts UNCLASSIFIED overlap and caps the tier at three', () => {
    const result = computeFlightStrip([task('a', 0, 10), task('b', 0, 10, 'CHECK'), task('c', 0, 10, null), task('d', 0, 10, 'THINK')]);
    expect(result.bars[0].concurrencyTier).toBe(3);
    expect(result.bars[0].fill).toBe('#c4f2d8');
    expect(result.peakConcurrency).toBe(4);
  });

  it.each([14, 15])('elides a %i-minute gap; labels only gaps at the threshold', gap => {
    const result = computeFlightStrip([task('a', 0, 5), task('b', 5 + gap, 10 + gap)]);
    expect(result.axisSpanMin).toBe(10);
    expect(result.bars.map(b => [b.x, b.width])).toEqual([[0, 0.5], [0.5, 0.5]]);
    expect(result.breaks).toHaveLength(gap === 15 ? 1 : 0);
    expect(result.idleElidedMin).toBe(gap);
    expect(result.phaseDividers).toEqual([]);
  });

  it.each([0, 15])('uses stored phases independently of a %i-minute idle gap', gap => {
    const a = { ...task('a', 0, 5), missionPhaseIndex: 1, missionPhaseLabel: 'Prepare' };
    const b = { ...task('b', 5 + gap, 10 + gap), missionPhaseIndex: 2, missionPhaseLabel: 'Implement' };
    const result = computeFlightStrip([b, a, task('unphased', 1, 2, null)]);
    expect(result.phaseDividers).toEqual([{ phaseIndex: 2, label: 'P2', phaseLabel: 'Implement', x: 0.5 }]);
    expect(result.bars).toHaveLength(3);
  });

  it('projects human notes onto compressed time, filters bots, and reports HUMAN %', () => {
    const planner = { ...task('planner', 7, 8), creationSource: 'orchestrator', mode: 'planning' };
    const result = computeFlightStrip([task('a', 0, 5), task('b', 25, 30), planner], {
      notes: [{ id: 'human', authorType: 'user', createdAt: at(12) }, { id: 'bot', authorType: 'bot', createdAt: at(15) }],
    });
    expect(result.railMarks.map(m => [m.kind, m.x])).toEqual([['orchestrator', 0.5], ['human', 0.5]]);
    expect(result.humanPercent).toBe(50);
  });

  it('supports an orchestrator-only mission and empty or unstarted missions without NaN', () => {
    const planner = { ...task('planner', 0, 10), creationSource: 'orchestrator', mode: 'planning' };
    const result = computeFlightStrip([planner]);
    expect(result.bars).toEqual([]);
    expect(result.railMarks[0].x).toBe(0);
    expect(result.parallelFactor).toBeNull();
    expect(result.humanPercent).toBe(0);
    expect(computeFlightStrip([]).humanPercent).toBeNull();
    planner.workers = [];
    expect(computeFlightStrip([planner]).railMarks).toEqual([]);
  });

  it('rejects malformed/reversed spans and uses completedAt → updatedAt → now', () => {
    const t = task('a', 0, 5);
    t.workers = [
      { status: 'running', startedAt: at(0), updatedAt: at(2) },
      { status: 'running', startedAt: at(2) },
      { status: 'failed', startedAt: 'invalid', completedAt: at(5) },
      { status: 'failed', startedAt: at(8), completedAt: at(5) },
    ];
    const result = computeFlightStrip([t], { now: epoch + 5 * MIN });
    expect(result.agentTimeMin).toBe(5);
    expect(result.peakConcurrency).toBe(1);
    expect(result.bars).toHaveLength(2);
  });

  it('estimates queued work from completed spans even when their end used updatedAt', () => {
    const completed: FlightStripTask = { id: 'done', lane: 'BUILD', workers: [
      { status: 'completed', startedAt: at(0), updatedAt: at(4) },
    ] };
    const result = computeFlightStrip([completed, { id: 'queued', status: 'pending' }], { status: 'active' });
    expect(result.queuedBars[0].estimatedDurationMin).toBe(4);
  });

  it('keeps queued estimates outside measured metrics and places the now-line before them', () => {
    const result = computeFlightStrip([task('done', 0, 10), { id: 'queued', status: 'pending', lane: 'CHECK' }], { status: 'active' });
    expect(result.nowX).toBe(0.5);
    expect(result.queuedBars[0]).toMatchObject({ x: 0.5, width: 0.5, estimatedDurationMin: 10 });
    expect(result.agentTimeMin).toBe(10);
    expect(result.axisSpanMin).toBe(10);
    expect(computeFlightStrip([{ id: 'queued', status: 'assigned' }], { status: 'active' }).queuedBars[0].estimatedDurationMin).toBe(15);
  });
});
