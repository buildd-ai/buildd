/**
 * Render the dispatch-outbox SQL builders through PgDialect, so a malformed
 * fragment fails here rather than in production. Behaviour against a real
 * database is apps/web/tests/db/dispatch-outbox.test.ts (bun run test:db).
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  claimDueDispatchesSql,
  defaultDedupeKey,
  dispatchHintSql,
  enqueueDispatchSql,
  outboxInsertSelectSql,
} from '../dispatch-outbox';

const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(q);

describe('enqueueDispatchSql', () => {
  test('binds every caller value as one jsonb parameter', () => {
    const { sql, params } = render(enqueueDispatchSql({ taskId: 't-1', cause: 'ci.retry', metadata: { targetLocalUiUrl: "x'); DROP TABLE tasks; --" } }));
    expect(params).toHaveLength(1);
    expect(JSON.parse(String(params[0]))).toMatchObject({ taskId: 't-1', cause: 'ci.retry', dedupeKey: 'now' });
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).toContain("ON CONFLICT (task_id, dedupe_key) WHERE status = 'pending'");
  });

  test('a future notBefore keys on its due time, matching the trigger', () => {
    const due = new Date(Date.now() + 60_000);
    const { params } = render(enqueueDispatchSql({ taskId: 't-1', cause: 'budget.available', notBefore: due }));
    expect(JSON.parse(String(params[0])).dedupeKey).toBe(`start_at:${due.getTime()}`);
    expect(defaultDedupeKey(new Date(Date.now() - 1000))).toBe('now');
  });
});

describe('outboxInsertSelectSql', () => {
  test('renders a CTE that only wakes pending tasks from the source', () => {
    const { sql, params } = render(outboxInsertSelectSql('woken', 'path_claim.released'));
    expect(params).toHaveLength(0);
    expect(sql).toMatch(/^wake AS \(/);
    expect(sql).toContain('FROM woken s JOIN tasks t ON t.id = s.waiting_task_id');
    expect(sql).toContain("WHERE t.status = 'pending'");
  });

  test('refuses anything that is not a plain identifier or a known cause', () => {
    expect(() => outboxInsertSelectSql('woken; DROP TABLE tasks', 'path_claim.released')).toThrow();
    expect(() => outboxInsertSelectSql('woken', "x'); --" as never)).toThrow();
  });
});

describe('claimDueDispatchesSql', () => {
  test('takes due or lease-expired rows with SKIP LOCKED and re-checks status on the UPDATE', () => {
    const { sql, params } = render(claimDueDispatchesSql(25));
    expect(params).toHaveLength(1);
    expect(JSON.parse(String(params[0]))).toMatchObject({ limit: 25, now: null });
    expect(sql).toContain('FOR UPDATE OF o SKIP LOCKED');
    expect(sql).toContain("o.status IN ('pending', 'delivering')");
  });
});

describe('dispatchHintSql', () => {
  test('sets a transaction-local hint with the payload bound, never inlined', () => {
    const { sql, params } = render(dispatchHintSql({ metadata: { targetLocalUiUrl: "x'); DROP TABLE tasks; --" } }));
    expect(sql).toBe("SELECT set_config('buildd.dispatch_hint', $1, true)");
    expect(JSON.parse(String(params[0]))).toEqual({ metadata: { targetLocalUiUrl: "x'); DROP TABLE tasks; --" } });
  });

  test('refuses a cause outside the vocabulary', () => {
    expect(() => dispatchHintSql({ cause: 'start_agent' as never })).toThrow('unknown cause');
  });
});
