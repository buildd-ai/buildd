import { describe, test, expect } from 'bun:test';
import { requestRefresh, flushRefresh } from './coalesced-refresh';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('requestRefresh', () => {
  test('N rapid calls for the same taskId collapse into a single refresh', async () => {
    const calls: number[] = [];
    const router = { refresh: () => calls.push(Date.now()) };

    for (let i = 0; i < 5; i++) {
      requestRefresh(router, 'task-rapid', 30, 200);
      await sleep(5);
    }

    expect(calls.length).toBe(0); // trailing timer keeps getting reset, nothing has fired yet
    await sleep(60);
    expect(calls.length).toBe(1);
  });

  test('different taskIds debounce independently', async () => {
    let a = 0;
    let b = 0;
    const routerA = { refresh: () => a++ };
    const routerB = { refresh: () => b++ };

    requestRefresh(routerA, 'task-a', 20, 100);
    requestRefresh(routerB, 'task-b', 20, 100);
    requestRefresh(routerA, 'task-a', 20, 100);

    await sleep(60);
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  test('maxWait fires even under a continuous stream that keeps resetting the trailing timer', async () => {
    const calls: number[] = [];
    const router = { refresh: () => calls.push(Date.now()) };
    const start = Date.now();

    // Fires every 15ms, well under the 40ms trailing delay, so the trailing
    // timer never gets a quiet window to fire on its own.
    const interval = setInterval(() => requestRefresh(router, 'task-steady', 40, 100), 15);
    await sleep(160);
    clearInterval(interval);

    expect(calls.length).toBeGreaterThanOrEqual(1);
    // Fired around maxWait (100ms), not postponed indefinitely by the stream.
    expect(calls[0] - start).toBeLessThan(150);
  });

});

describe('flushRefresh', () => {
  test('refreshes immediately and clears any pending debounced call for that taskId', async () => {
    let count = 0;
    const router = { refresh: () => count++ };

    requestRefresh(router, 'task-flush', 50, 200);
    flushRefresh(router, 'task-flush');
    expect(count).toBe(1);

    await sleep(80);
    expect(count).toBe(1); // the earlier debounced call must not also fire
  });

  test('flushRefresh with no pending call still refreshes once', () => {
    let count = 0;
    const router = { refresh: () => count++ };
    flushRefresh(router, 'task-flush-standalone');
    expect(count).toBe(1);
  });
});
