/**
 * Render the Dispatch handoff SQL builders through PgDialect. Behaviour
 * against a real database: apps/web/tests/db/dispatch-handoff.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  ackHandoffSql,
  ackMergedSql,
  applyReceiptsSql,
  claimCustodySql,
  parseAppliedReceipts,
  fallBackToInAppSql,
  selectForRepublishSql,
  selectOrphanCandidatesSql,
  terminalReceiptFor,
  ORPHAN_CEILING_MS,
  ORPHAN_MIN_AGE_MS,
  inDispatchCustody,
  isProjectableReceipt,
  selectForPublishSql,
  PUBLISH_BACKOFF_MS,
} from '../dispatch-handoff';

const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(q);
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const AT = '2026-10-03T12:00:00.000Z';

describe('selectForPublishSql', () => {
  test('binds one jsonb parameter and takes only unacked pending work rows of publishing workspaces', () => {
    const { sql, params } = render(selectForPublishSql({ taskId: A, limit: 7 }));
    expect(params).toHaveLength(1);
    expect(JSON.parse(String(params[0]))).toMatchObject({ taskId: A, limit: 7, backoffMs: PUBLISH_BACKOFF_MS });
    expect(sql).toContain("o.status = 'pending' AND o.handed_off_at IS NULL AND o.intent = 'work_execution'");
    expect(sql).toContain("w.dispatch_transport IN ('shadow', 'dispatch')");
    expect(sql).toContain('FOR UPDATE OF o SKIP LOCKED');
    expect(sql).toContain('SET published_at =');
  });

  test('a task id that is not a uuid is dropped, not bound into a cast', () => {
    const { params } = render(selectForPublishSql({ taskId: "x'); DROP TABLE tasks; --" }));
    expect(JSON.parse(String(params[0])).taskId).toBeNull();
  });
});

describe('ack statements', () => {
  test('accepted/duplicate: one statement, dispatch → handed_off only from pending, shadow → handed_off_at only', () => {
    const { sql, params } = render(ackHandoffSql([{ id: A, mode: 'dispatch' }, { id: B, mode: 'shadow' }, { id: 'bad', mode: 'dispatch' }]));
    expect(params).toHaveLength(1);
    expect(JSON.parse(String(params[0]))).toEqual([{ id: A, mode: 'dispatch' }, { id: B, mode: 'shadow' }]);
    expect(sql).toContain("CASE WHEN acks.mode = 'dispatch' THEN 'handed_off' ELSE o.status END");
    expect(sql).toContain("(acks.mode = 'dispatch' AND o.status = 'pending') OR acks.mode = 'shadow'");
  });

  test('merged: one statement carrying the into id', () => {
    const { sql, params } = render(ackMergedSql([{ id: A, mode: 'dispatch', into: B }, { id: B, mode: 'dispatch', into: 'nope' }]));
    expect(JSON.parse(String(params[0]))).toEqual([{ id: A, mode: 'dispatch', into: B }]);
    expect(sql).toContain("'merged_into_pending'");
    expect(sql).toContain('merged_into = CASE');
  });
});

describe('claimCustodySql', () => {
  test('binds the id and only takes a published, unacked, pending row of a dispatch or shadow workspace that was not taken back', () => {
    const { sql, params } = render(claimCustodySql(A));
    expect(params).toEqual([A]);
    expect(sql).toContain("o.status = 'pending' AND o.handed_off_at IS NULL AND o.published_at IS NOT NULL");
    expect(sql).toContain("w.dispatch_transport IN ('dispatch', 'shadow')");
    expect(sql).toContain("dispatchFallbackAt");
    expect(sql).toContain("CASE WHEN w.dispatch_transport = 'dispatch' THEN 'handed_off' ELSE o.status END");
  });
});

describe('applyReceiptsSql', () => {
  test('one statement over jsonb_to_recordset; malformed receipts never reach SQL', () => {
    const { sql, params } = render(applyReceiptsSql([
      { id: A, attempt: 1, event: 'delivered', via: 'webhook', at: AT },
      { id: 'not-a-uuid', attempt: 1, event: 'delivered', at: AT },
      { id: B, attempt: 1, event: 'merged', at: AT },
      { id: B, attempt: 1, event: 'shrugged' as never, at: AT },
    ]));
    expect(params).toHaveLength(1);
    expect(JSON.parse(String(params[0])).map((r: { id: string }) => r.id)).toEqual([A]);
    expect(sql).toContain('jsonb_to_recordset');
    expect(sql).toContain("o.status = 'handed_off' AND o.transport = 'dispatch'");
  });

  test('returns the rows this batch moved to failed, with workspace and error, for the alert', () => {
    const { sql } = render(applyReceiptsSql([{ id: A, attempt: 2, event: 'failed', why: 'http_500', at: AT }]));
    expect(sql).toContain('RETURNING o.id, o.workspace_id, o.status, o.last_error');
    expect(sql).toContain("FILTER (WHERE u.status = 'failed')");
    expect(sql).toContain('AS failed');
  });

  test('parseAppliedReceipts: count plus failed rows, jsonb as text or array', () => {
    expect(parseAppliedReceipts(undefined)).toEqual({ applied: 0, failed: [] });
    expect(parseAppliedReceipts({ n: '2', failed: `[{"id":"${A}","workspaceId":"${B}","error":"http_500"}]` }))
      .toEqual({ applied: 2, failed: [{ id: A, workspaceId: B, error: 'http_500' }] });
    expect(parseAppliedReceipts({ n: 1, failed: [{ id: A, workspaceId: B, error: null }] }).failed).toEqual([{ id: A, workspaceId: B, error: null }]);
  });

  test('a long error is truncated before it is bound', () => {
    const { params } = render(applyReceiptsSql([{ id: A, attempt: 2, event: 'failed', why: 'x'.repeat(2000), at: AT }]));
    expect(JSON.parse(String(params[0]))[0].why).toHaveLength(500);
  });

  test('isProjectableReceipt', () => {
    expect(isProjectableReceipt({ id: A, attempt: 0, event: 'attempted', at: AT })).toBe(true);
    expect(isProjectableReceipt({ id: A, attempt: -1, event: 'attempted', at: AT })).toBe(false);
    expect(isProjectableReceipt({ id: A, attempt: 1, event: 'merged', into: B, at: AT })).toBe(true);
    expect(isProjectableReceipt({ id: A, attempt: 1, event: 'delivered', at: 'yesterday' })).toBe(false);
  });
});

describe('inDispatchCustody', () => {
  test('handed_off, or a shadow row Dispatch acked that is still pending', () => {
    expect(inDispatchCustody({ status: 'handed_off', handedOffAt: new Date() })).toBe(true);
    expect(inDispatchCustody({ status: 'pending', handedOffAt: new Date() })).toBe(true);
    expect(inDispatchCustody({ status: 'pending', handedOffAt: null })).toBe(false);
    expect(inDispatchCustody({ status: 'delivered', handedOffAt: new Date() })).toBe(false);
  });
});

describe('orphan reconcile builders', () => {
  test('candidate selection binds one jsonb parameter and reads only handed-off dispatch rows', () => {
    const { sql, params } = render(selectOrphanCandidatesSql({ limit: 9 }));
    expect(params).toHaveLength(1);
    expect(JSON.parse(String(params[0]))).toMatchObject({ minAgeMs: ORPHAN_MIN_AGE_MS, ceilingMs: ORPHAN_CEILING_MS, limit: 9 });
    expect(sql).toContain("o.status = 'handed_off' AND o.transport = 'dispatch'");
    expect(sql).not.toContain('FOR UPDATE');
  });

  test('re-publish selection and the fallback flip drop non-uuids and guard on handed_off', () => {
    for (const q of [selectForRepublishSql([A, 'nope', B]), fallBackToInAppSql([A, 'nope', B])]) {
      const { sql, params } = render(q);
      expect(JSON.parse(String(params[0]))).toEqual([A, B]);
      expect(sql).toContain("o.status = 'handed_off'");
    }
    const flip = render(fallBackToInAppSql([A])).sql;
    expect(flip).toContain("status = 'pending', transport = 'in_app', handed_off_at = NULL");
  });

  test('terminalReceiptFor maps each terminal state and refuses open or unprojectable ones', () => {
    expect(terminalReceiptFor({ id: A, state: 'skipped', attempt: 1, via: 'skipped:held', closedAt: AT }, AT))
      .toEqual({ id: A, attempt: 1, event: 'delivered', via: 'skipped:held', at: AT });
    expect(terminalReceiptFor({ id: A, state: 'expired', attempt: 0, why: 'expires_at' }, AT))
      .toEqual({ id: A, attempt: 0, event: 'expired', why: 'expires_at', at: AT });
    expect(terminalReceiptFor({ id: A, state: 'queued', attempt: 0 }, AT)).toBeNull();
    expect(terminalReceiptFor({ id: A, state: 'merged', attempt: 0 }, AT)).toBeNull();
    expect(terminalReceiptFor({ id: 'nope', state: 'delivered', attempt: 1 }, AT)).toBeNull();
  });
});
