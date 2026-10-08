import { describe, it, expect } from 'bun:test';
import { resolveBandDrillQaState, sampleBandSelection } from './sample-band';
import { splitTaskRoots } from '../../../tasks/TaskGrid';
import { BAND_LABEL } from '@/components/insights/flow-chart-model';

const NOW = Date.UTC(2026, 9, 6, 12);

describe('resolveBandDrillQaState', () => {
  it('accepts sample and large on the dev server', () => {
    expect(resolveBandDrillQaState('sample', 'development')).toBe('sample');
    expect(resolveBandDrillQaState(['large'], 'development')).toBe('large');
  });

  it('is ignored in production and for unknown values', () => {
    expect(resolveBandDrillQaState('sample', 'production')).toBeNull();
    expect(resolveBandDrillQaState('large', undefined)).toBeNull();
    expect(resolveBandDrillQaState('bogus', 'development')).toBeNull();
    expect(resolveBandDrillQaState(undefined, 'development')).toBeNull();
  });
});

describe('sampleBandSelection', () => {
  it('sample: a populated band whose rows all render as roots', () => {
    const s = sampleBandSelection('sample', undefined, NOW);
    expect(s.tasks.length).toBeGreaterThan(5);
    expect(s.tasks.length).toBeLessThan(50);
    expect(splitTaskRoots(s.tasks).rootTasks).toHaveLength(s.tasks.length);
  });

  it('large: a band holding hundreds of rows', () => {
    const s = sampleBandSelection('large', undefined, NOW);
    expect(s.tasks.length).toBeGreaterThanOrEqual(300);
    expect(splitTaskRoots(s.tasks).rootTasks).toHaveLength(s.tasks.length);
  });

  it('labels the selection like a real drill-down, defaulting to Released', () => {
    expect(sampleBandSelection('sample', undefined, NOW).label.startsWith(`${BAND_LABEL.released} · `)).toBe(true);
    expect(sampleBandSelection('sample', 'lost', NOW).label.startsWith(`${BAND_LABEL.lost} · `)).toBe(true);
    expect(sampleBandSelection('sample', 'nope', NOW).label.startsWith(`${BAND_LABEL.released} · `)).toBe(true);
  });

  it('is deterministic, with unique ids and timestamps inside the window', () => {
    const a = sampleBandSelection('large', undefined, NOW);
    expect(sampleBandSelection('large', undefined, NOW)).toEqual(a);
    expect(new Set(a.tasks.map(t => t.id)).size).toBe(a.tasks.length);
    for (const t of a.tasks) {
      const ts = Date.parse(t.updatedAt);
      expect(ts).toBeLessThanOrEqual(NOW);
      expect(ts).toBeGreaterThan(NOW - 30 * 86_400_000);
    }
  });

  it('mixes statuses so the status chips have counts', () => {
    const statuses = new Set(sampleBandSelection('large', undefined, NOW).tasks.map(t => t.status));
    expect(statuses.has('completed')).toBe(true);
    expect(statuses.has('failed')).toBe(true);
    expect(statuses.has('in_progress')).toBe(true);
  });
});
