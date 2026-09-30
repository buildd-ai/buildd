/**
 * send_worker_message's rate limit must be one atomic statement: the check is
 * the WHERE clause and the increment reads the column in its own SET. Asserted
 * rendered, since a mocked db cannot show a lost update.
 */
import { describe, it, expect, mock } from 'bun:test';

const mockReturning = mock(() => Promise.resolve([{ id: 'sender' }] as any[]));
const mockWhere = mock((_w: any) => ({ returning: mockReturning }));
const mockSet = mock((_s: any) => ({ where: mockWhere }));
mock.module('@buildd/core/db', () => ({ db: { update: mock(() => ({ set: mockSet })) } }));

import { PgDialect } from 'drizzle-orm/pg-core';
import {
  WORKER_MSG_MAX_PER_WINDOW,
  WORKER_MSG_RATE_WINDOW_MS,
  buildWorkerMsgRateLimitAllowedSql,
  buildWorkerMsgRateLimitSetSql,
  consumeWorkerMsgRateLimit,
  workerMsgRetryAfterSeconds,
} from './worker-message-rate-limit';

const dialect = new PgDialect();
const render = (v: any) => dialect.sqlToQuery(v);
const RECIPIENT = '22222222-2222-2222-2222-222222222222';
const NOW = 1_700_000_000_000;

describe('worker message rate limit SQL', () => {
  it('SET touches only context.workerMsgRateLimit, reading the current column', () => {
    const q = render(buildWorkerMsgRateLimitSetSql(RECIPIENT, NOW));
    expect(q.sql).toMatch(/^jsonb_set\(\s*COALESCE\("tasks"\."context", '\{\}'::jsonb\),\s*'\{workerMsgRateLimit\}'/);
    expect(q.sql).toContain(`COALESCE("tasks"."context" -> 'workerMsgRateLimit', '{}'::jsonb)`);
    // fresh-window branch and increment branch both present
    expect(q.sql).toContain('CASE WHEN');
    expect(q.sql).toMatch(/\+ 1/);
    expect(q.params).toContain(RECIPIENT);
    expect(q.params).toContain(NOW);
    expect(q.params).toContain(WORKER_MSG_RATE_WINDOW_MS);
  });

  it('WHERE allows an expired window or a count under the cap', () => {
    const q = render(buildWorkerMsgRateLimitAllowedSql(RECIPIENT, NOW));
    expect(q.sql).toMatch(/> \$\d+\) OR /);
    expect(q.sql).toMatch(/< \$\d+\)$/);
    expect(q.params).toContain(WORKER_MSG_MAX_PER_WINDOW);
    expect(q.params).toContain(RECIPIENT);
  });

  it('consume issues one guarded UPDATE and maps zero rows to refused', async () => {
    expect(await consumeWorkerMsgRateLimit('sender', RECIPIENT, NOW)).toBe(true);
    expect(mockSet).toHaveBeenCalledTimes(1);
    const where = render(mockWhere.mock.calls[0][0]);
    expect(where.sql).toContain('"tasks"."id" =');
    expect(where.params).toContain('sender');
    expect(where.params).toContain(WORKER_MSG_MAX_PER_WINDOW);

    mockReturning.mockResolvedValueOnce([]);
    expect(await consumeWorkerMsgRateLimit('sender', RECIPIENT, NOW)).toBe(false);
  });

  it('retryAfter is the rest of the current window, at least 1s', () => {
    expect(workerMsgRetryAfterSeconds({ workerMsgRateLimit: { windowStart: NOW - 10_000 } }, NOW)).toBe(50);
    expect(workerMsgRetryAfterSeconds({}, NOW)).toBe(60);
    expect(workerMsgRetryAfterSeconds({ workerMsgRateLimit: { windowStart: NOW - 90_000 } }, NOW)).toBe(1);
  });
});
