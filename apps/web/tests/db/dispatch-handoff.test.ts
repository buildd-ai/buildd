/**
 * The Dispatch transport handoff against real Postgres: publish selection,
 * the ack statements, the in-app drain's exclusion, receipt projection and
 * the health counters. Contract: docs/specs/task-dispatch-authority.md,
 * "Dispatch transport (P0)" (AC-25..AC-30).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import {
  claimDueDispatchesSql,
  dispatchHistoryForTask,
  dispatchOutboxHealth,
  enqueueDispatchSql,
} from '@buildd/core/dispatch-outbox';
import {
  ackHandoff,
  ackMerged,
  applyReceipts,
  loadCustodyRow,
  selectForPublish,
} from '@buildd/core/dispatch-handoff';
import { assertDbConfigured, q, seedTask, seedWorkspace, settleOutbox } from './harness';

let inApp: string;
let shadow: string;
let dispatch: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId: inApp } = await seedWorkspace());
  ({ workspaceId: shadow } = await seedWorkspace({ dispatchTransport: 'shadow' }));
  ({ workspaceId: dispatch } = await seedWorkspace({ dispatchTransport: 'dispatch' }));
});

type OutRow = { id: string; status: string; transport: string; handed_off_at: string | null; published_at: string | null;
  delivered_via: string | null; merged_into: string | null; attempt_count: number; last_error: string | null; delivered_at: string | null };
const rowsFor = (taskId: string) => q<OutRow>(sql`
  SELECT id, status, transport, handed_off_at, published_at, delivered_via, merged_into, attempt_count, last_error, delivered_at
  FROM task_dispatch_outbox WHERE task_id = ${taskId}::uuid ORDER BY created_at, id`);
const claimedIds = async (nowIso?: string) => (await q<{ id: string }>(claimDueDispatchesSql(1000, nowIso))).map(r => r.id);

/** Publish this task's row and ack it as accepted. */
async function handOff(taskId: string) {
  const rows = (await selectForPublish({ taskId, limit: 1 })).filter(r => r.taskId === taskId);
  await ackHandoff(rows.map(r => ({ id: r.id, mode: r.mode })));
  return rows;
}

describe('publish selection', () => {
  test('takes unacked work rows of shadow and dispatch workspaces only, and stamps published_at', async () => {
    const a = await seedTask(inApp);
    const s = await seedTask(shadow);
    const d = await seedTask(dispatch);
    const picked = await selectForPublish({ limit: 1000 });
    const tasks = picked.map(r => r.taskId);
    expect(tasks).toContain(s);
    expect(tasks).toContain(d);
    expect(tasks).not.toContain(a);
    expect(picked.find(r => r.taskId === s)!.mode).toBe('shadow');
    expect(picked.find(r => r.taskId === d)!.mode).toBe('dispatch');
    expect((await rowsFor(d))[0].published_at).not.toBeNull();
    expect((await rowsFor(a))[0].published_at).toBeNull();
  });

  test('a row published moments ago is not re-sent (backoff); this task comes first', async () => {
    const d = await seedTask(dispatch);
    expect((await selectForPublish({ taskId: d, limit: 1 })).map(r => r.taskId)).toEqual([d]);
    expect((await selectForPublish({ taskId: d, limit: 1000 })).map(r => r.taskId)).not.toContain(d);
    await db.execute(sql`UPDATE task_dispatch_outbox SET published_at = now() - interval '1 minute' WHERE task_id = ${d}::uuid`);
    expect((await selectForPublish({ taskId: d, limit: 1 })).map(r => r.taskId)).toEqual([d]);
  });

  test('a non-work intent is never published', async () => {
    const d = await seedTask(dispatch, { status: 'completed' });
    await db.execute(enqueueDispatchSql({ taskId: d, intent: 'notification', cause: 'policy.requested' }));
    expect((await selectForPublish({ taskId: d, limit: 1000 })).map(r => r.taskId)).not.toContain(d);
  });
});

describe('ack statements', () => {
  test('dispatch: accepted → handed_off, transport dispatch, handed_off_at set', async () => {
    const d = await seedTask(dispatch);
    await handOff(d);
    expect((await rowsFor(d))[0]).toMatchObject({ status: 'handed_off', transport: 'dispatch' });
    expect((await rowsFor(d))[0].handed_off_at).not.toBeNull();
  });

  test('shadow: accepted → only handed_off_at; the row stays pending for the in-app drain', async () => {
    const s = await seedTask(shadow);
    await handOff(s);
    const [r] = await rowsFor(s);
    expect(r).toMatchObject({ status: 'pending', transport: 'in_app' });
    expect(r.handed_off_at).not.toBeNull();
  });

  test('re-acking (a duplicate publish) changes nothing', async () => {
    const d = await seedTask(dispatch);
    const rows = await handOff(d);
    const before = await rowsFor(d);
    expect(await ackHandoff(rows.map(r => ({ id: r.id, mode: r.mode })))).toBe(0);
    expect(await rowsFor(d)).toEqual(before);
  });

  test('a dispatch row the in-app fallback already took keeps its own lifecycle', async () => {
    const d = await seedTask(dispatch);
    const rows = (await selectForPublish({ taskId: d, limit: 1 }));
    await db.execute(sql`UPDATE task_dispatch_outbox SET status = 'delivering' WHERE task_id = ${d}::uuid`);
    expect(await ackHandoff(rows.map(r => ({ id: r.id, mode: r.mode })))).toBe(0);
    expect((await rowsFor(d))[0].status).toBe('delivering');
  });

  test('merged: a dispatch row closes as merged_into_pending with merged_into; a shadow row only records the ack', async () => {
    const d1 = await seedTask(dispatch);
    const d2 = await seedTask(dispatch);
    const [into] = await handOff(d1);
    const [m] = await selectForPublish({ taskId: d2, limit: 1 });
    await ackMerged([{ id: m.id, mode: 'dispatch', into: into.id }]);
    expect((await rowsFor(d2))[0]).toMatchObject({ status: 'delivered', delivered_via: 'merged_into_pending', merged_into: into.id, transport: 'dispatch' });

    const s = await seedTask(shadow);
    const [sm] = await selectForPublish({ taskId: s, limit: 1 });
    await ackMerged([{ id: sm.id, mode: 'shadow', into: into.id }]);
    const [sr] = await rowsFor(s);
    expect(sr).toMatchObject({ status: 'pending', merged_into: null, delivered_via: null });
    expect(sr.handed_off_at).not.toBeNull();
  });

  test('a handed-off row frees the pending dedupe slot: a later state change writes its own row', async () => {
    const d = await seedTask(dispatch);
    await handOff(d);
    await db.execute(enqueueDispatchSql({ taskId: d, cause: 'ci.retry' }));
    expect((await rowsFor(d)).map(r => r.status).sort()).toEqual(['handed_off', 'pending']);
  });
});

describe('in-app drain exclusion', () => {
  test('a handed_off row is never claimed, however late', async () => {
    await settleOutbox();
    const d = await seedTask(dispatch);
    const [r] = await handOff(d);
    expect(await claimedIds(new Date(Date.now() + 86_400_000).toISOString())).not.toContain(r.id);
  });

  test('an unacked young dispatch row is left to publish; once past the grace the drain takes it as the fallback', async () => {
    await settleOutbox();
    const d = await seedTask(dispatch);
    const [r] = await rowsFor(d);
    expect(await claimedIds()).not.toContain(r.id);
    await db.execute(sql`UPDATE task_dispatch_outbox SET created_at = now() - interval '3 minutes' WHERE id = ${r.id}::uuid`);
    expect(await claimedIds()).toContain(r.id);
  });

  test('with no Worker configured (grace 0) a young unacked dispatch row is taken at once', async () => {
    await settleOutbox();
    const d = await seedTask(dispatch);
    const [r] = await rowsFor(d);
    const ids = (await q<{ id: string }>(claimDueDispatchesSql(1000, undefined, 0))).map(x => x.id);
    expect(ids).toContain(r.id);
  });

  test('in_app and shadow workspaces are claimed exactly as before (no grace)', async () => {
    await settleOutbox();
    const a = await seedTask(inApp);
    const s = await seedTask(shadow);
    const s2 = await seedTask(shadow);
    await handOff(s2); // acked shadow row: the in-app drain still delivers it
    const ids = await claimedIds();
    for (const t of [a, s, s2]) expect(ids).toContain((await rowsFor(t))[0].id);
  });

  test('a non-work intent of a dispatch workspace is claimed at once (it is never published)', async () => {
    await settleOutbox();
    const d = await seedTask(dispatch, { status: 'completed' });
    await db.execute(enqueueDispatchSql({ taskId: d, intent: 'notification', cause: 'policy.requested' }));
    expect(await claimedIds()).toContain((await rowsFor(d))[0].id);
  });
});

describe('receipts projection', () => {
  const at = () => new Date().toISOString();

  test('delivered / failed / merged / expired close the row; attempted moves the counters only', async () => {
    const ids: Record<string, string> = {};
    await Promise.all(['delivered', 'failed', 'merged', 'expired', 'attempted'].map(async k => {
      const t = await seedTask(dispatch);
      ids[k] = (await handOff(t))[0].id;
      ids[`${k}:task`] = t;
    }));
    const n = await applyReceipts([
      { id: ids.delivered, attempt: 1, event: 'delivered', via: 'relay:pusher', at: at() },
      { id: ids.failed, attempt: 8, event: 'failed', why: 'webhook 500', at: at() },
      { id: ids.merged, attempt: 0, event: 'merged', into: ids.delivered, at: at() },
      { id: ids.expired, attempt: 2, event: 'expired', why: 'stale', at: at() },
      { id: ids.attempted, attempt: 3, event: 'attempted', why: 'timeout', at: at() },
    ]);
    expect(n).toBe(5);
    expect((await rowsFor(ids['delivered:task']))[0]).toMatchObject({ status: 'delivered', delivered_via: 'relay:pusher', attempt_count: 1 });
    expect((await rowsFor(ids['failed:task']))[0]).toMatchObject({ status: 'failed', last_error: 'webhook 500', attempt_count: 8 });
    expect((await rowsFor(ids['merged:task']))[0]).toMatchObject({ status: 'delivered', delivered_via: 'merged_into_pending', merged_into: ids.delivered });
    expect((await rowsFor(ids['expired:task']))[0]).toMatchObject({ status: 'delivered', delivered_via: 'expired' });
    expect((await rowsFor(ids['attempted:task']))[0]).toMatchObject({ status: 'handed_off', attempt_count: 3, last_error: 'timeout' });
    expect((await rowsFor(ids['delivered:task']))[0].delivered_at).not.toBeNull();
  });

  test('re-applying the same batch is a no-op', async () => {
    const t1 = await seedTask(dispatch);
    const t2 = await seedTask(dispatch);
    const [r1] = await handOff(t1);
    const [r2] = await handOff(t2);
    const batch = [
      { id: r1.id, attempt: 2, event: 'attempted' as const, why: 'busy', at: at() },
      { id: r2.id, attempt: 1, event: 'delivered' as const, via: 'webhook', at: at() },
    ];
    expect(await applyReceipts(batch)).toBe(2);
    const before = [...await rowsFor(t1), ...await rowsFor(t2)];
    expect(await applyReceipts(batch)).toBe(0);
    expect([...await rowsFor(t1), ...await rowsFor(t2)]).toEqual(before);
  });

  test('within one batch the terminal receipt wins and the highest attempt is kept', async () => {
    const t = await seedTask(dispatch);
    const [r] = await handOff(t);
    await applyReceipts([
      { id: r.id, attempt: 1, event: 'attempted', why: 'x', at: new Date(Date.now() - 2000).toISOString() },
      { id: r.id, attempt: 2, event: 'delivered', via: 'webhook', at: at() },
      { id: r.id, attempt: 3, event: 'attempted', why: 'late', at: new Date(Date.now() - 1000).toISOString() },
    ]);
    expect((await rowsFor(t))[0]).toMatchObject({ status: 'delivered', delivered_via: 'webhook', attempt_count: 3 });
  });

  test('shadow rows and unknown ids are never touched', async () => {
    const s = await seedTask(shadow);
    const [r] = await handOff(s);
    const before = await rowsFor(s);
    expect(await applyReceipts([
      { id: r.id, attempt: 1, event: 'delivered', via: 'relay:pusher', at: at() },
      { id: '00000000-0000-4000-8000-000000000000', attempt: 1, event: 'failed', at: at() },
    ])).toBe(0);
    expect(await rowsFor(s)).toEqual(before);
  });
});

describe('custody, health and history', () => {
  test('loadCustodyRow reads the transport columns', async () => {
    const d = await seedTask(dispatch);
    const [r] = await handOff(d);
    expect(await loadCustodyRow(r.id)).toMatchObject({ id: r.id, status: 'handed_off', transport: 'dispatch', workspaceId: dispatch, taskId: d });
    expect(await loadCustodyRow('nope')).toBeNull();
  });

  test('unacked counts dispatch work rows over a minute old with no ack; orphaned counts handoffs an hour past due', async () => {
    const before = await dispatchOutboxHealth();
    const u = await seedTask(dispatch);
    await db.execute(sql`UPDATE task_dispatch_outbox SET created_at = now() - interval '2 minutes' WHERE task_id = ${u}::uuid`);
    const young = await seedTask(dispatch); // under a minute: not yet unacked
    const notDispatch = await seedTask(shadow);
    await db.execute(sql`UPDATE task_dispatch_outbox SET created_at = now() - interval '2 minutes' WHERE task_id = ${notDispatch}::uuid`);
    const o = await seedTask(dispatch);
    await handOff(o);
    await db.execute(sql`UPDATE task_dispatch_outbox SET not_before = now() - interval '2 hours' WHERE task_id = ${o}::uuid`);
    const after = await dispatchOutboxHealth();
    expect(after.unacked - before.unacked).toBe(1);
    expect(after.orphaned - before.orphaned).toBe(1);
    expect(young).toBeTruthy();
  });

  test('dispatchHistoryForTask returns transport and handed_off_at', async () => {
    const d = await seedTask(dispatch);
    await handOff(d);
    const [h] = await dispatchHistoryForTask(d);
    expect(h.transport).toBe('dispatch');
    expect(h.handedOffAt).not.toBeNull();
  });
});
