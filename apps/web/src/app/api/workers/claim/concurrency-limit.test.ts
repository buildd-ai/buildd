import { describe, it, expect } from 'bun:test';
import { mapWithConcurrency } from './concurrency-limit';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('mapWithConcurrency', () => {
  it('never runs more than `limit` calls at once', async () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const limit = 4;
    let inFlight = 0;
    let maxInFlight = 0;
    const gates = items.map(() => deferred<number>());

    const resultPromise = mapWithConcurrency(items, limit, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const value = await gates[i].promise;
      inFlight--;
      return value;
    });

    // Let the first wave start.
    await new Promise((r) => setTimeout(r, 0));
    expect(inFlight).toBe(limit);

    // Release them one at a time; concurrency must never exceed the cap even
    // as later items start filling freed slots.
    for (const g of gates) {
      g.resolve(0);
      await new Promise((r) => setTimeout(r, 0));
      expect(inFlight).toBeLessThanOrEqual(limit);
    }

    await resultPromise;
    expect(maxInFlight).toBe(limit);
  });

  it('returns results in input order regardless of completion order', async () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const gates = new Map(items.map((i) => [i, deferred<string>()]));

    const resultPromise = mapWithConcurrency(items, 2, async (i) => gates.get(i)!.promise);

    // Resolve out of order.
    gates.get('b')!.resolve('B');
    gates.get('a')!.resolve('A');
    gates.get('e')!.resolve('E');
    gates.get('d')!.resolve('D');
    gates.get('c')!.resolve('C');

    const result = await resultPromise;
    expect(result).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('runs every item when there are fewer items than the cap', async () => {
    const started: number[] = [];
    const result = await mapWithConcurrency([1, 2, 3], 10, async (i) => {
      started.push(i);
      return i * 2;
    });
    expect(started.sort()).toEqual([1, 2, 3]);
    expect(result).toEqual([2, 4, 6]);
  });

  it('handles an empty input without hanging', async () => {
    const result = await mapWithConcurrency([], 4, async () => 1);
    expect(result).toEqual([]);
  });
});
