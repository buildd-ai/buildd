import { describe, expect, it } from 'bun:test';
import { deriveFlightStripLane, type WorkKind } from './task-presentation';
import { computeFlightStrip } from '@buildd/core/mission-helpers';

describe('deriveFlightStripLane', () => {
  it.each([
    ['engineering', 'BUILD'], ['analysis', 'CHECK'], ['observation', 'CHECK'],
    ['research', 'THINK'], ['design', 'THINK'], ['writing', 'THINK'], ['coordination', 'THINK'],
  ])('maps %s to %s', (kind, lane) => {
    expect(deriveFlightStripLane({ kind: kind as WorkKind })).toBe(lane);
  });
  it('preserves deriveWorkKind precedence and does not guess from unknown roles or retry lineage', () => {
    expect(deriveFlightStripLane({ kind: 'writing', roleSlug: 'builder', taskType: 'review' })).toBe('THINK');
    expect(deriveFlightStripLane({ roleSlug: 'reviewer' })).toBe('CHECK');
    expect(deriveFlightStripLane({ taskType: 'review-retry' })).toBe('CHECK');
    expect(deriveFlightStripLane({ roleSlug: 'custom', taskType: 'retry' })).toBe('UNCLASSIFIED');
  });
  it('AC-2: passes unresolved work through to a visible UNCLASSIFIED bar', () => {
    const lane = deriveFlightStripLane({ kind: null, roleSlug: null, taskType: null });
    const result = computeFlightStrip([{ id: 'unknown', lane, workers: [{ status: 'completed', startedAt: '2025-01-01T00:00:00Z', completedAt: '2025-01-01T00:05:00Z' }] }]);
    expect(result.bars[0].lane).toBe('UNCLASSIFIED');
    expect(result.agentTimeMin).toBe(5);
  });
});
