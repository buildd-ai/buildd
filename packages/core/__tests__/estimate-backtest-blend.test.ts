import { describe, it, expect } from 'bun:test';
import { compareBlend, type PairedRow } from '../estimate-backtest-blend';

const row = (i: number, actual: number, cur: number | null, blend: number, prior = 60): PairedRow => ({
  taskId: `t${i}`, actual, priorCompleted: prior, current: { p50: cur, p80: null }, blend: { p50: blend, p80: blend * 1.7 },
});

describe('compareBlend', () => {
  it('calls the blend better only when its log error is clearly lower', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i, 60, 20, 55));
    expect(compareBlend(rows).verdict).toBe('blend_better');
  });
  it('says no_better when the blend does not beat the current estimator', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i, 60, 58, 20));
    expect(compareBlend(rows).verdict).toBe('no_better');
  });
  it('scores the blend against neighbours alone on the rows neighbours answered', () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => ({ ...row(i, 60, 58, 40), currentSource: 'neighbours' as const })),
      ...Array.from({ length: 30 }, (_, i) => ({ ...row(50 + i, 60, 20, 55), currentSource: 'bucket' as const })),
    ];
    const c = compareBlend(rows);
    const n = c.byCurrentSource.find(s => s.source === 'neighbours')!;
    expect(n.blend.medianAbsLogError!).toBeGreaterThan(n.current.medianAbsLogError!);
  });

  it('needs at least 30 scored tasks', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i, 60, 20, 55));
    expect(compareBlend(rows).verdict).toBe('insufficient');
  });
  it('splits by workspace history without pooling arms', () => {
    const rows = [...Array.from({ length: 35 }, (_, i) => row(i, 60, 20, 55, 0)), ...Array.from({ length: 35 }, (_, i) => row(100 + i, 60, 58, 59, 80))];
    const c = compareBlend(rows);
    expect(c.byHistory.find(b => b.band === '0')!.current.scored).toBe(35);
    expect(c.byHistory.find(b => b.band === '50+')!.blend.scored).toBe(35);
  });
});
