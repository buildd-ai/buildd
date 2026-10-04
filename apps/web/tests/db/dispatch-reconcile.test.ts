/**
 * The orphan reconcile's SQL against real Postgres: candidate selection, the
 * re-publish selection, the in-app fallback flip (and that the drain, the
 * publish sweep, health and receipts all honour it), and the projection of
 * a lost terminal receipt through the receipts statement. Decision logic
 * with a fake Worker: apps/web/src/lib/dispatch-reconcile.test.ts. Contract:
 * docs/specs/task-dispatch-authority.md, "Dispatch transport", AC-31..AC-34.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import {
  claimDueDispatchesSql,
  dispatchOutboxHealth,
  DISPATCH_FALLBACK_KEY,
} from '@buildd/core/dispatch-outbox';
import {
  ackHandoff,
  applyReceipts,
  fallBackToInApp,
  loadCustodyRow,
  ORPHAN_CEILING_MS,
  ORPHAN_MIN_AGE_MS,
  selectForPublish,
  selectForRepublish,
  selectOrphanCandidates,
  terminalReceiptFor,
} from '@buildd/core/dispatch-handoff';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

let dispatch: string;
let shadow: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId: dispatch } = await seedWorkspace({ dispatchTransport: 'dispatch' }));
  ({ workspaceId: shadow } = await seedWorkspace({ dispatchTransport: 'shadow' }));
});

type OutRow = {
  id: string; status: string; transport: string; handed_off_at: string | null; published_at: string | null;
  delivered_via: string | null; delivered_at: string | null; last_error: string | null; merged_into: string | null;
  attempt_count: number; metadata: Record<string, unknown> | null;
};
const rowOf = async (taskId: string) => (await q<OutRow>(sql`
  SELECT id, status, transport, handed_off_at, published_at, delivered_via, delivered_at, last_error, merged_into, attempt_count, metadata
  FROM task_dispatch_outbox WHERE task_id = ${taskId}::uuid ORDER BY created_at, id`))[0]!;

/** A dispatch task's row, published and acked, due `dueAgoMs` ago. */
async function handedOff(dueAgoMs: number, ws = dispatch): Promise<{ taskId: string; id: string }> {
  const taskId = await seedTask(ws);
  const rows = (await selectForPublish({ taskId, limit: 1 })).filter(r => r.taskId === taskId);
  await ackHandoff(rows.map(r => ({ id: r.id, mode: r.mode })));
  await db.execute(sql`UPDATE task_dispatch_outbox
    SET not_before = now() - ${dueAgoMs} * interval '1 millisecond',
        created_at = now() - ${dueAgoMs} * interval '1 millisecond' - interval '1 second'
    WHERE task_id = ${taskId}::uuid`);
  return { taskId, id: rows[0]!.id };
}
const candidateIds = async () => new Map((await selectOrphanCandidates({ limit: 100_000 })).map(c => [c.id, c]));

describe('orphan candidate selection', () => {
  test('handed_off dispatch rows due over ORPHAN_MIN_AGE_MS ago, flagged past the ceiling', async () => {
    const recent = await handedOff(ORPHAN_MIN_AGE_MS - 60_000);
    const due = await handedOff(ORPHAN_MIN_AGE_MS + 60_000);
    const old = await handedOff(ORPHAN_CEILING_MS + 60_000);
    const delivered = await handedOff(ORPHAN_MIN_AGE_MS + 60_000);
    await db.execute(sql`UPDATE task_dispatch_outbox SET status = 'delivered' WHERE id = ${delivered.id}::uuid`);
    const pending = await seedTask(dispatch);
    await db.execute(sql`UPDATE task_dispatch_outbox SET not_before = now() - interval '2 hours' WHERE task_id = ${pending}::uuid`);
    const shadowRow = await handedOff(ORPHAN_CEILING_MS + 60_000, shadow);

    const c = await candidateIds();
    expect(c.has(recent.id)).toBe(false);
    expect(c.get(due.id)).toMatchObject({ workspaceId: dispatch, pastCeiling: false });
    expect(c.get(old.id)).toMatchObject({ workspaceId: dispatch, pastCeiling: true });
    expect(c.has(delivered.id)).toBe(false);
    expect(c.has((await rowOf(pending)).id)).toBe(false);
    expect(c.has(shadowRow.id)).toBe(false); // shadow: the in-app drain owns it, Dispatch only compares
  });

  test('oldest due first, bounded by the limit', async () => {
    const a = await handedOff(ORPHAN_CEILING_MS * 50);
    const b = await handedOff(ORPHAN_CEILING_MS * 49);
    const two = await selectOrphanCandidates({ limit: 2 });
    // Leftovers from earlier runs may be older still; ours must come in order.
    const all = (await selectOrphanCandidates({ limit: 100_000 })).map(r => r.id);
    expect(all.indexOf(a.id)).toBeLessThan(all.indexOf(b.id));
    expect(two).toHaveLength(2);
  });
});

describe('re-publish selection', () => {
  test('returns a handed_off row as publishable and stamps published_at, leaving it handed_off', async () => {
    const h = await handedOff(ORPHAN_MIN_AGE_MS + 60_000);
    await db.execute(sql`UPDATE task_dispatch_outbox SET published_at = now() - interval '1 hour' WHERE id = ${h.id}::uuid`);
    const before = await rowOf(h.taskId);
    const rows = await selectForRepublish([h.id]);
    expect(rows.map(r => ({ id: r.id, taskId: r.taskId, mode: r.mode, intent: r.intent }))).toEqual([
      { id: h.id, taskId: h.taskId, mode: 'dispatch', intent: 'work_execution' },
    ]);
    const after = await rowOf(h.taskId);
    expect(after.status).toBe('handed_off');
    expect(new Date(after.published_at!).getTime()).toBeGreaterThan(new Date(before.published_at!).getTime());
  });

  test('never returns a row that is not handed_off, nor a non-uuid', async () => {
    const h = await handedOff(ORPHAN_MIN_AGE_MS + 60_000);
    await db.execute(sql`UPDATE task_dispatch_outbox SET status = 'delivered' WHERE id = ${h.id}::uuid`);
    expect(await selectForRepublish([h.id, 'not-a-uuid'])).toEqual([]);
  });

  test('reports the workspace transport as it is now (a workspace rolled back to in_app is not re-published)', async () => {
    const { workspaceId } = await seedWorkspace({ dispatchTransport: 'dispatch' });
    const h = await handedOff(ORPHAN_MIN_AGE_MS + 60_000, workspaceId);
    await db.execute(sql`UPDATE workspaces SET dispatch_transport = 'in_app' WHERE id = ${workspaceId}::uuid`);
    expect((await selectForRepublish([h.id])).map(r => r.mode)).toEqual(['in_app']);
  });
});

describe('in-app fallback flip', () => {
  test('handed_off → pending, transport in_app, handed_off_at NULL, marked; idempotent', async () => {
    const h = await handedOff(ORPHAN_CEILING_MS + 60_000);
    expect(await fallBackToInApp([h.id, 'not-a-uuid'])).toBe(1);
    const r = await rowOf(h.taskId);
    expect(r).toMatchObject({ status: 'pending', transport: 'in_app', handed_off_at: null });
    expect(typeof r.metadata?.[DISPATCH_FALLBACK_KEY]).toBe('string');
    expect(await fallBackToInApp([h.id])).toBe(0);
  });

  test('a row a receipt closed in the meantime is not flipped', async () => {
    const h = await handedOff(ORPHAN_CEILING_MS + 60_000);
    await applyReceipts([{ id: h.id, attempt: 1, event: 'delivered', via: 'relay:pusher', at: new Date().toISOString() }]);
    expect(await fallBackToInApp([h.id])).toBe(0);
    expect((await rowOf(h.taskId)).status).toBe('delivered');
  });

  test('keeps an existing metadata object (a targeted wake stays targeted)', async () => {
    const h = await handedOff(ORPHAN_CEILING_MS + 60_000);
    await db.execute(sql`UPDATE task_dispatch_outbox SET metadata = '{"targetLocalUiUrl":"http://r.test"}'::jsonb WHERE id = ${h.id}::uuid`);
    await fallBackToInApp([h.id]);
    expect((await rowOf(h.taskId)).metadata).toMatchObject({ targetLocalUiUrl: 'http://r.test' });
  });

  test('the drain takes a fallen-back row at once, even one created inside the publish grace', async () => {
    const h = await handedOff(ORPHAN_CEILING_MS + 60_000);
    await fallBackToInApp([h.id]);
    // Worst case for the grace: a row whose created_at is younger than PUBLISH_GRACE_MS.
    await db.execute(sql`UPDATE task_dispatch_outbox SET created_at = now() WHERE id = ${h.id}::uuid`);
    const claimed = (await q<{ id: string }>(claimDueDispatchesSql(100_000))).map(r => r.id);
    expect(claimed).toContain(h.id);
  });

  test('a fallen-back row is never re-published, never counted unacked, and is out of Dispatch custody', async () => {
    const h = await handedOff(ORPHAN_CEILING_MS + 60_000);
    await fallBackToInApp([h.id]);
    await db.execute(sql`UPDATE task_dispatch_outbox SET published_at = NULL, created_at = now() - interval '10 minutes' WHERE id = ${h.id}::uuid`);
    const before = await dispatchOutboxHealth();
    expect((await selectForPublish({ taskId: h.taskId, limit: 100 })).map(r => r.id)).not.toContain(h.id);
    expect((await selectForRepublish([h.id]))).toEqual([]);
    const row = await loadCustodyRow(h.id);
    expect(row).toMatchObject({ status: 'pending', transport: 'in_app', handedOffAt: null });
    // Health: flipping one more row in must not move `unacked`.
    const h2 = await handedOff(ORPHAN_CEILING_MS + 60_000);
    await fallBackToInApp([h2.id]);
    await db.execute(sql`UPDATE task_dispatch_outbox SET created_at = now() - interval '10 minutes' WHERE id = ${h2.id}::uuid`);
    expect((await dispatchOutboxHealth()).unacked).toBe(before.unacked);
  });

  test("a late Worker receipt for a fallen-back row changes nothing: the in-app drain owns it", async () => {
    const h = await handedOff(ORPHAN_CEILING_MS + 60_000);
    await fallBackToInApp([h.id]);
    expect(await applyReceipts([{ id: h.id, attempt: 2, event: 'failed', why: 'late', at: new Date().toISOString() }])).toBe(0);
    expect((await rowOf(h.taskId)).status).toBe('pending');
  });
});

describe('projecting a lost terminal receipt from the lookup', () => {
  const AT = '2026-10-04T10:00:00.000Z';
  test('each terminal state closes the row through the receipts statement, and re-applying is a no-op', async () => {
    const delivered = await handedOff(ORPHAN_MIN_AGE_MS + 60_000);
    const skipped = await handedOff(ORPHAN_MIN_AGE_MS + 60_000);
    const failed = await handedOff(ORPHAN_MIN_AGE_MS + 60_000);
    const expired = await handedOff(ORPHAN_MIN_AGE_MS + 60_000);
    const merged = await handedOff(ORPHAN_MIN_AGE_MS + 60_000);
    const receipts = [
      terminalReceiptFor({ id: delivered.id, state: 'delivered', attempt: 2, via: 'relay:pusher', closedAt: AT }, AT),
      terminalReceiptFor({ id: skipped.id, state: 'skipped', attempt: 1, via: 'skipped:held', closedAt: AT }, AT),
      terminalReceiptFor({ id: failed.id, state: 'failed', attempt: 8, why: 'relay_http_502', closedAt: AT }, AT),
      terminalReceiptFor({ id: expired.id, state: 'expired', attempt: 0, why: 'expires_at', closedAt: AT }, AT),
      terminalReceiptFor({ id: merged.id, state: 'merged', attempt: 0, mergedInto: delivered.id, closedAt: AT }, AT),
    ].filter(r => r !== null);
    expect(receipts).toHaveLength(5);
    expect(await applyReceipts(receipts)).toBe(5);

    expect(await rowOf(delivered.taskId)).toMatchObject({ status: 'delivered', delivered_via: 'relay:pusher', attempt_count: 2 });
    expect(new Date((await rowOf(delivered.taskId)).delivered_at!).toISOString()).toBe(AT);
    expect(await rowOf(skipped.taskId)).toMatchObject({ status: 'delivered', delivered_via: 'skipped:held' });
    expect(await rowOf(failed.taskId)).toMatchObject({ status: 'failed', last_error: 'relay_http_502', attempt_count: 8 });
    expect(await rowOf(expired.taskId)).toMatchObject({ status: 'delivered', delivered_via: 'expired' });
    expect(await rowOf(merged.taskId)).toMatchObject({ status: 'delivered', delivered_via: 'merged_into_pending', merged_into: delivered.id });

    expect(await applyReceipts(receipts)).toBe(0);
  });

  test('a summary from a Worker that predates via/closedAt still projects (via defaults to dispatch, at to now)', async () => {
    const h = await handedOff(ORPHAN_MIN_AGE_MS + 60_000);
    const r = terminalReceiptFor({ id: h.id, state: 'delivered', attempt: 1 }, AT)!;
    expect(r).toEqual({ id: h.id, attempt: 1, event: 'delivered', at: AT });
    expect(await applyReceipts([r])).toBe(1);
    expect(await rowOf(h.taskId)).toMatchObject({ status: 'delivered', delivered_via: 'dispatch' });
  });
});
