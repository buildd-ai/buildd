/**
 * The web ledger writer hands each batch to after(), so the write outlives the
 * response on Vercel instead of riding a promise the platform may freeze.
 */
import { describe, it, expect } from 'bun:test';
import { createAfterResponseMemoryLedger } from './memory-ledger';
import type { MemoryUseRow } from '@buildd/core/memory-retrieval';

const ROW: MemoryUseRow = {
  teamId: '11111111-1111-4111-8111-111111111111', workspaceId: null, taskId: null, workerId: null,
  chunkId: null, memoryId: 'm', caller: 'recall', via: 'pull', rank: 1, score: null, gatedBy: null,
};

describe('afterResponseMemoryLedger', () => {
  it('schedules the write with after() and does not write inline', async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const written: MemoryUseRow[][] = [];
    const ledger = createAfterResponseMemoryLedger(
      task => { scheduled.push(task); },
      async rows => { written.push(rows); },
    );
    ledger([ROW]);
    expect(written).toEqual([]);
    expect(scheduled).toHaveLength(1);
    await scheduled[0]();
    expect(written).toEqual([[ROW]]);
  });

  it('outside a request scope (after() throws), falls back to fire-and-forget', async () => {
    const written: MemoryUseRow[][] = [];
    const ledger = createAfterResponseMemoryLedger(
      () => { throw new Error('`after` was called outside a request scope'); },
      async rows => { written.push(rows); },
    );
    expect(() => ledger([ROW])).not.toThrow();
    await Promise.resolve();
    expect(written).toEqual([[ROW]]);
  });

  it('an empty batch schedules nothing', () => {
    const scheduled: unknown[] = [];
    createAfterResponseMemoryLedger(t => { scheduled.push(t); }, async () => {})([]);
    expect(scheduled).toEqual([]);
  });
});
