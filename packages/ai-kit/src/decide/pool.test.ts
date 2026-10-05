import { describe, expect, it } from 'bun:test';
import { runDecisionPool } from './index';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('runDecisionPool', () => {
  it('runs every item, in order, with at most `concurrency` in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const res = await runDecisionPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], async n => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await wait(5);
      inFlight--;
      return n * 2;
    }, { concurrency: 3 });
    expect(peak).toBe(3);
    expect(res.map(r => (r.status === 'done' ? r.value : null))).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  });

  it('defaults to 8 workers', async () => {
    let inFlight = 0;
    let peak = 0;
    await runDecisionPool(Array.from({ length: 20 }, (_, i) => i), async () => {
      inFlight++; peak = Math.max(peak, inFlight); await wait(2); inFlight--;
    });
    expect(peak).toBe(8);
  });

  it('isolates a failing item', async () => {
    const res = await runDecisionPool([1, 2, 3], async n => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    expect(res.map(r => r.status)).toEqual(['done', 'error', 'done']);
  });

  it('returns within the budget: in-flight items time out, the rest never start', async () => {
    const t0 = Date.now();
    // The worker never resolves, so the budget's timeout always wins the race
    // against it — a real `wait()` here raced two real timers against each
    // other and flaked under full-suite CPU contention (a worker occasionally
    // "won" if its timer fired before the budget's, or a lane missed its
    // start window before the deadline). A wide budget below gives the two
    // concurrency lanes headroom to both start under scheduling jitter.
    const res = await runDecisionPool(Array.from({ length: 10 }, (_, i) => i), () => new Promise<number>(() => {}), {
      concurrency: 2, budgetMs: 300,
    });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(res.filter(r => r.status === 'timed_out')).toHaveLength(2);
    expect(res.filter(r => r.status === 'not_started')).toHaveLength(8);
  });

  it('tells each worker how much budget is left', async () => {
    let t = 0;
    const seen: number[] = [];
    await runDecisionPool([1, 2], async () => { seen.push(1_000 - t); t += 300; }, { concurrency: 1, budgetMs: 1_000, now: () => t });
    expect(seen).toEqual([1_000, 700]);
  });

  it('handles an empty list', async () => {
    expect(await runDecisionPool([], async () => 1)).toEqual([]);
  });
});
