import { describe, expect, it } from 'bun:test';
import { computeMissionFlightStrip, FLIGHT_STRIP_IDLE_THRESHOLD_MS } from '@buildd/core/mission-helpers';
import { computeFlightDetailStats, describeSteeringPattern, formatFlightDuration } from './flight-detail-stats';

const date = (ms: number) => new Date(ms);
const worker = (id: string, taskId: string, start: number, end: number, extra: Record<string, unknown> = {}) => ({
  id,
  taskId,
  status: 'completed',
  startedAt: date(start),
  completedAt: date(end),
  ...extra,
});

describe('computeFlightDetailStats', () => {
  it('reports agent time and idle elided from the strip model, and null loops/human% with no lane or steering data', () => {
    const strip = computeMissionFlightStrip(
      [{ id: 'a', status: 'completed' }],
      [worker('w1', 'a', 0, 60_000)],
    );
    const stats = computeFlightDetailStats(strip);
    expect(stats.agentTimeMs).toBe(strip.durationMs);
    expect(stats.idleElidedMs).toBe(0);
    expect(stats.buildCheckLoops).toBeNull();
    expect(stats.humanPct).toBeNull();
  });

  it('sums every elided gap into idleElidedMs', () => {
    const GAP = FLIGHT_STRIP_IDLE_THRESHOLD_MS; // the elision boundary itself (Rule X-2, AC-8)
    const strip = computeMissionFlightStrip(
      [{ id: 'a', status: 'completed' }, { id: 'b', status: 'completed' }],
      [worker('w1', 'a', 0, 60_000), worker('w2', 'b', 60_000 + GAP, 120_000 + GAP)],
    );
    const stats = computeFlightDetailStats(strip);
    expect(stats.idleElidedMs).toBe(GAP);
  });

  it('counts a single BUILD -> CHECK -> BUILD round trip as one loop', () => {
    const tasks = [
      { id: 'b1', status: 'completed', roleSlug: 'builder' },
      { id: 'c1', status: 'completed', roleSlug: 'reviewer' },
      { id: 'b2', status: 'completed', roleSlug: 'builder' },
    ];
    const strip = computeMissionFlightStrip(tasks, [
      worker('w1', 'b1', 0, 10),
      worker('w2', 'c1', 10, 20),
      worker('w3', 'b2', 20, 30),
    ]);
    expect(computeFlightDetailStats(strip).buildCheckLoops).toBe(1);
  });

  it('does not double-count consecutive bars in the same lane as separate loop legs', () => {
    const tasks = [
      { id: 'b1', status: 'completed', roleSlug: 'builder' },
      { id: 'b2', status: 'completed', roleSlug: 'builder' },
      { id: 'c1', status: 'completed', roleSlug: 'reviewer' },
      { id: 'b3', status: 'completed', roleSlug: 'builder' },
    ];
    const strip = computeMissionFlightStrip(tasks, [
      worker('w1', 'b1', 0, 10),
      worker('w2', 'b2', 10, 20),
      worker('w3', 'c1', 20, 30),
      worker('w4', 'b3', 30, 40),
    ]);
    expect(computeFlightDetailStats(strip).buildCheckLoops).toBe(1);
  });

  it('computes humanPct as a share of human vs orchestrator touches, counting clustered orchestrator cycles', () => {
    const strip = computeMissionFlightStrip([], [], {
      steeringEvents: [
        { id: 'h1', kind: 'human', at: date(0) },
        { id: 'h2', kind: 'human', at: date(1) },
        { id: 'o1', kind: 'orchestrator', at: date(2) },
        { id: 'o2', kind: 'orchestrator', at: date(3) },
      ],
    });
    // 2 human, 2 orchestrator -> 50%
    expect(computeFlightDetailStats(strip).humanPct).toBe(50);
  });
});

describe('describeSteeringPattern', () => {
  it('reports zero mid-flight touches when the only human mark sits at the axis origin', () => {
    const strip = computeMissionFlightStrip(
      [{ id: 'a', status: 'completed' }],
      [worker('w1', 'a', 0, 100)],
      { steeringEvents: [{ id: 'h1', kind: 'human', at: date(0) }] },
    );
    expect(describeSteeringPattern(strip)).toBe('0 of 1 human touch landed mid-flight.');
  });

  it('describes an unattended mission with no steering marks at all', () => {
    const strip = computeMissionFlightStrip(
      [{ id: 'a', status: 'completed' }],
      [worker('w1', 'a', 0, 100)],
    );
    expect(describeSteeringPattern(strip)).toBe('No steering recorded — the mission ran unattended.');
  });

  it('distinguishes orchestrator-only from truly unattended missions', () => {
    const strip = computeMissionFlightStrip([], [], {
      steeringEvents: [{ id: 'o1', kind: 'orchestrator', at: date(0) }],
    });
    expect(describeSteeringPattern(strip)).toBe('No human steering — the orchestrator ran the mission unattended.');
  });

  it('appends a failure clause when a bar carries the failure fill', () => {
    const strip = computeMissionFlightStrip(
      [{ id: 'a', status: 'completed' }],
      [worker('w1', 'a', 0, 100, { exitCause: 'code_failure' })],
    );
    expect(describeSteeringPattern(strip)).toBe('No steering recorded — the mission ran unattended. 1 build failed and was retried.');
  });
});

describe('formatFlightDuration', () => {
  it('formats sub-minute durations as <1m', () => {
    expect(formatFlightDuration(30_000)).toBe('<1m');
  });

  it('formats minutes without an hour component', () => {
    expect(formatFlightDuration(45 * 60_000)).toBe('45m');
  });

  it('formats hours and minutes', () => {
    expect(formatFlightDuration((6 * 60 + 17) * 60_000)).toBe('6h 17m');
  });

  it('omits a zero minute remainder', () => {
    expect(formatFlightDuration(3 * 60 * 60_000)).toBe('3h');
  });
});
