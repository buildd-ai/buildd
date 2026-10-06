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
  dispatchOutboxHealthSql,
  dispatchTeamHealthSql,
  latestDispatchForTaskSql,
  dispatchHistoryForTaskSql,
  toDispatchHistoryEntry,
  parseDispatchTeamHealth,
  PUBLISH_GRACE_MS,
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
    expect(params).toEqual(['path_claim.released', 'path_claim.released']);
    expect(sql).toMatch(/^"wake" AS \(/);
    expect(sql).toContain('FROM "woken" s JOIN tasks t ON t.id = s.waiting_task_id');
    expect(sql).toContain("WHERE t.status = 'pending'");
  });

  test('quotes the CTE names and refuses an unknown cause', () => {
    const { sql } = render(outboxInsertSelectSql('woken; DROP TABLE tasks', 'path_claim.released'));
    expect(sql).toContain('FROM "woken; DROP TABLE tasks" s');
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

  test('never takes a handed_off row: only pending and lease-expired delivering rows qualify', () => {
    const { sql } = render(claimDueDispatchesSql(25));
    expect(sql).not.toContain('handed_off\'');
    expect(sql).toContain("(o.status = 'pending' AND o.not_before <= c.now");
    expect(sql).toContain("OR (o.status = 'delivering' AND o.last_attempt_at <");
  });

  test('the publish grace is scoped to unacked work rows of dispatch-transport workspaces only', () => {
    const { sql, params } = render(claimDueDispatchesSql(25));
    expect(JSON.parse(String(params[0])).graceMs).toBe(PUBLISH_GRACE_MS);
    expect(sql).toContain("o.handed_off_at IS NULL AND o.intent = 'work_execution'");
    expect(sql).toContain("w.dispatch_transport = 'dispatch'");
    // An in_app or shadow workspace never matches the exclusion.
    expect(sql).not.toContain("'shadow'");
    expect(sql).not.toContain("'in_app'");
  });
});

describe('dispatchOutboxHealthSql', () => {
  test('reports unacked dispatch rows and orphaned handoffs alongside the old counters', () => {
    const { sql, params } = render(dispatchOutboxHealthSql());
    expect(params).toHaveLength(0);
    for (const col of ['overdue', 'stuck', 'failed', 'unacked', 'orphaned', 'unacked_stale']) expect(sql).toContain(`AS ${col}`);
    expect(sql).toContain("o.status = 'handed_off' AND o.not_before < now() - interval '1 hour'");
  });
});

describe('dispatchOutboxHealthSql unacked_stale', () => {
  test('only counts rows due past the fallback that were never taken back', () => {
    const { sql } = render(dispatchOutboxHealthSql());
    const stale = sql.slice(sql.indexOf('AS orphaned'));
    expect(stale).toContain("o.not_before < now() - interval '5 minutes'");
    expect(stale).toContain("o.created_at < now() - interval '5 minutes'");
    expect(stale).toContain("w.dispatch_transport = 'dispatch'");
    expect(stale).toContain('dispatchFallbackAt');
  });
});

describe('dispatchTeamHealthSql', () => {
  const WS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  test('scopes to the given workspaces through one bound jsonb parameter', () => {
    const { sql, params } = render(dispatchTeamHealthSql(WS));
    expect(params).toHaveLength(1);
    expect(JSON.parse(String(params[0]))).toEqual({ ws: WS });
    expect(sql).toContain("o.workspace_id IN (SELECT jsonb_array_elements_text(a->'ws')::uuid FROM args)");
    expect(sql).not.toContain('ANY(');
  });

  test('reports every count, by-route deliveries and latency percentiles', () => {
    const { sql } = render(dispatchTeamHealthSql(WS));
    for (const col of ['pending', 'due', 'overdue', 'delivering', 'stuck', 'handed_off', 'unacked', 'unacked_stale', 'orphaned', 'failed_24h', 'delivered_24h', 'delivered_via', 'p50', 'p95', 'samples']) {
      expect(sql).toContain(`AS ${col}`);
    }
    expect(sql).toContain('percentile_cont(0.95)');
    // Latency is delivery time, so folded and expired wakes are not deliveries.
    expect(sql).toContain("via NOT IN ('merged_into_pending', 'expired')");
  });

  test('parse: numbers from strings, null percentiles, jsonb by-route as text or object', () => {
    expect(parseDispatchTeamHealth(undefined)).toMatchObject({ pending: 0, deliveredVia: {}, latencyMs: { p50: null, p95: null, samples: 0 } });
    const h = parseDispatchTeamHealth({
      pending: '3', due: '1', overdue: '0', delivering: '0', stuck: '0', handed_off: '2', unacked: '1', unacked_stale: '0',
      orphaned: '0', failed_24h: '1', delivered_24h: '9', delivered_via: '{"dispatch":7,"pusher":2}', p50: '812.4', p95: 4100, samples: '9',
    });
    expect(h).toMatchObject({ pending: 3, handedOff: 2, failed24h: 1, delivered24h: 9, deliveredVia: { dispatch: 7, pusher: 2 } });
    expect(h.latencyMs).toEqual({ p50: 812, p95: 4100, samples: 9 });
    expect(parseDispatchTeamHealth({ delivered_via: { webhook: '4' } }).deliveredVia).toEqual({ webhook: 4 });
  });
});

describe('latestDispatchForTaskSql', () => {
  test('newest row for the task, task id bound', () => {
    const { sql, params } = render(latestDispatchForTaskSql('33333333-3333-4333-8333-333333333333'));
    expect(params).toEqual(['33333333-3333-4333-8333-333333333333']);
    expect(sql).toContain('ORDER BY created_at DESC, id DESC LIMIT 1');
  });
});

describe('dispatchHistoryForTaskSql', () => {
  test('the newest rows, returned oldest first', () => {
    const { sql, params } = render(dispatchHistoryForTaskSql('33333333-3333-4333-8333-333333333333', 20));
    expect(params).toEqual(['33333333-3333-4333-8333-333333333333', 20]);
    expect(sql).toContain('ORDER BY created_at DESC, id DESC LIMIT $2');
    expect(sql.trim().endsWith('ORDER BY created_at, id')).toBe(true);
  });

  test('toDispatchHistoryEntry: camelCase, ISO times, causes from text or array', () => {
    const e = toDispatchHistoryEntry({
      id: 'r1', intent: 'work_execution', cause: 'task.created', causes: '["task.created","ci.retry"]', status: 'handed_off',
      transport: 'dispatch', not_before: '2026-10-04 12:00:00+00', handed_off_at: '2026-10-04T12:00:01Z', delivered_at: null,
      delivered_via: null, attempt_count: '1', last_error: null, created_at: '2026-10-04T11:59:59Z',
    });
    expect(e).toEqual({
      id: 'r1', intent: 'work_execution', cause: 'task.created', causes: ['task.created', 'ci.retry'], status: 'handed_off',
      transport: 'dispatch', notBefore: '2026-10-04T12:00:00.000Z', handedOffAt: '2026-10-04T12:00:01.000Z', deliveredAt: null,
      deliveredVia: null, attemptCount: 1, lastError: null, createdAt: '2026-10-04T11:59:59.000Z',
    });
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
