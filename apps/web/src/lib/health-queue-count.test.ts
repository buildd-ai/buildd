/**
 * The Queue tab's waiting count (spec 4bc3e70e r8 R-1): the Queue tab
 * publishes its own read's count; the count is per workspace filter.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { publishQueueWaitingCount, queueWaitingCountFor, resetQueueWaitingCount } from './health-queue-count';

afterEach(() => resetQueueWaitingCount());

describe('queue waiting count', () => {
  it('reads back the count published for the same workspace filter, and nothing for another', () => {
    publishQueueWaitingCount(9, null, 1_000);
    expect(queueWaitingCountFor({ count: 9, workspace: null, at: 1_000 }, null)).toBe(9);
    expect(queueWaitingCountFor({ count: 9, workspace: null, at: 1_000 }, 'ws-1')).toBeNull();
  });

  it('nothing published reads null', () => {
    expect(queueWaitingCountFor({ count: null, workspace: null, at: 0 }, null)).toBeNull();
  });
});
