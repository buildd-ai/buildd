import { expect, test } from 'bun:test';
import { withRetry } from '../src/retry';

test('retries until the call succeeds', async () => {
  let n = 0;
  const v = await withRetry(async () => { if (++n < 3) throw new Error('flaky'); return n; }, { retries: 3, baseMs: 1 });
  expect(v).toBe(3);
});

test('gives up after retries + 1 attempts', async () => {
  let n = 0;
  await expect(withRetry(async () => { n++; throw new Error('down'); }, { retries: 2, baseMs: 1 })).rejects.toThrow('down');
  expect(n).toBe(3);
});
