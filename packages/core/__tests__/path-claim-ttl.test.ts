/**
 * A path-claim holder parked on a question (`waiting_input`) for longer than
 * PARKED_HOLDER_TTL_MS stops deferring other tasks. These pin the predicate
 * and the per-task rule both claim-route layers and check_path_claim share.
 */
import { describe, it, expect } from 'bun:test';
import {
  PARKED_HOLDER_TTL_MS,
  isExpiredParkedHolder,
  expiredParkedTaskIds,
} from '../path-claim-ttl';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms);

describe('isExpiredParkedHolder', () => {
  it('a waiting_input holder older than the TTL is expired', () => {
    expect(isExpiredParkedHolder({ status: 'waiting_input', updatedAt: ago(PARKED_HOLDER_TTL_MS + 1) }, NOW)).toBe(true);
  });

  it('a waiting_input holder inside the TTL still holds', () => {
    expect(isExpiredParkedHolder({ status: 'waiting_input', updatedAt: ago(PARKED_HOLDER_TTL_MS - 1000) }, NOW)).toBe(false);
  });

  it('a running holder never expires, however old its row', () => {
    expect(isExpiredParkedHolder({ status: 'running', updatedAt: ago(PARKED_HOLDER_TTL_MS * 10) }, NOW)).toBe(false);
  });

  it('a completed holder with an open PR never expires — its edits are in the PR', () => {
    expect(isExpiredParkedHolder({ status: 'completed', updatedAt: ago(PARKED_HOLDER_TTL_MS * 10) }, NOW)).toBe(false);
  });

  it('a missing or unparseable clock fails closed (still holds)', () => {
    expect(isExpiredParkedHolder({ status: 'waiting_input', updatedAt: null }, NOW)).toBe(false);
    expect(isExpiredParkedHolder({ status: 'waiting_input', updatedAt: 'not-a-date' }, NOW)).toBe(false);
  });

  it('accepts an ISO string clock', () => {
    expect(isExpiredParkedHolder({ status: 'waiting_input', updatedAt: ago(PARKED_HOLDER_TTL_MS * 2).toISOString() }, NOW)).toBe(true);
  });
});

describe('expiredParkedTaskIds', () => {
  it('a task whose only live worker is parked past the TTL is expired', () => {
    const out = expiredParkedTaskIds([
      { taskId: 't1', status: 'waiting_input', updatedAt: ago(PARKED_HOLDER_TTL_MS * 2) },
    ], NOW);
    expect([...out]).toEqual(['t1']);
  });

  it('a task with any non-expired live worker still holds', () => {
    const out = expiredParkedTaskIds([
      { taskId: 't1', status: 'waiting_input', updatedAt: ago(PARKED_HOLDER_TTL_MS * 2) },
      { taskId: 't1', status: 'running', updatedAt: ago(1000) },
      { taskId: 't2', status: 'waiting_input', updatedAt: ago(1000) },
    ], NOW);
    expect(out.size).toBe(0);
  });

  it('ignores rows without a task id', () => {
    const out = expiredParkedTaskIds([
      { taskId: null, status: 'waiting_input', updatedAt: ago(PARKED_HOLDER_TTL_MS * 2) },
    ], NOW);
    expect(out.size).toBe(0);
  });
});
