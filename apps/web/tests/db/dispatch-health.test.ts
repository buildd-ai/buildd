/**
 * Dispatch health reads against real Postgres: the team-scoped counts behind
 * dispatch_health and the /app/health Dispatch section, the unacked-past-the-
 * fallback counter the floor alerts on, and the failed rows a receipt batch
 * returns for the receipts route's alert. Contract:
 * docs/specs/task-dispatch-authority.md, "Observability" (AC-35..AC-37).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { dispatchOutboxHealth, dispatchTeamHealth, latestDispatchForTask } from '@buildd/core/dispatch-outbox';
import { ackHandoff, applyReceiptsDetailed, selectForPublish } from '@buildd/core/dispatch-handoff';
import { assertDbConfigured, seedTask, seedWorkspace } from './harness';

/** Sequential proxy round trips are slow on CI (see dispatch-reconcile.test.ts). */
const DB_TIMEOUT_MS = 30_000;

let mine: string;
let other: string;
let inApp: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId: mine } = await seedWorkspace({ dispatchTransport: 'dispatch' }));
  ({ workspaceId: other } = await seedWorkspace({ dispatchTransport: 'dispatch' }));
  ({ workspaceId: inApp } = await seedWorkspace());
});

async function handOff(taskId: string) {
  const rows = (await selectForPublish({ taskId, limit: 1 })).filter(r => r.taskId === taskId);
  await ackHandoff(rows.map(r => ({ id: r.id, mode: r.mode })));
  return rows;
}

describe('dispatchTeamHealth', () => {
  test('counts only the given workspaces', async () => {
    const before = await dispatchTeamHealth([mine]);
    await seedTask(other);
    await seedTask(other);
    const t = await seedTask(mine);
    const after = await dispatchTeamHealth([mine]);
    expect(after.pending - before.pending).toBe(1);
    expect(await latestDispatchForTask(t)).toMatchObject({ status: 'pending' });
  }, DB_TIMEOUT_MS);

  test('handed off, orphaned, failed, delivered by route and latency', async () => {
    const before = await dispatchTeamHealth([mine]);
    const h = await seedTask(mine);
    await handOff(h);
    const o = await seedTask(mine);
    await handOff(o);
    await db.execute(sql`UPDATE task_dispatch_outbox SET not_before = now() - interval '2 hours' WHERE task_id = ${o}::uuid`);
    const d = await seedTask(mine);
    await db.execute(sql`UPDATE task_dispatch_outbox SET status = 'delivered', delivered_via = 'webhook',
      not_before = now() - interval '10 seconds', delivered_at = now() - interval '8 seconds' WHERE task_id = ${d}::uuid`);
    const m = await seedTask(mine);
    await db.execute(sql`UPDATE task_dispatch_outbox SET status = 'delivered', delivered_via = 'merged_into_pending',
      not_before = now() - interval '1 hour', delivered_at = now() WHERE task_id = ${m}::uuid`);
    const f = await seedTask(mine);
    await db.execute(sql`UPDATE task_dispatch_outbox SET status = 'failed', last_error = 'http_500' WHERE task_id = ${f}::uuid`);

    const after = await dispatchTeamHealth([mine]);
    expect(after.handedOff - before.handedOff).toBe(2);
    expect(after.orphaned - before.orphaned).toBe(1);
    expect(after.failed24h - before.failed24h).toBe(1);
    expect(after.delivered24h - before.delivered24h).toBe(2);
    expect((after.deliveredVia.webhook ?? 0) - (before.deliveredVia.webhook ?? 0)).toBe(1);
    // A folded wake is a delivery by route, never a latency sample.
    expect(after.latencyMs.samples - before.latencyMs.samples).toBe(1);
    expect(after.latencyMs.p50).not.toBeNull();
  }, DB_TIMEOUT_MS);

  test('unacked past the fallback: old and due, never acked, never taken back, dispatch only', async () => {
    const team0 = await dispatchTeamHealth([mine, inApp]);
    const global0 = await dispatchOutboxHealth();
    const stale = await seedTask(mine);
    await db.execute(sql`UPDATE task_dispatch_outbox SET created_at = now() - interval '10 minutes', not_before = now() - interval '10 minutes' WHERE task_id = ${stale}::uuid`);
    const fresh = await seedTask(mine);
    await db.execute(sql`UPDATE task_dispatch_outbox SET created_at = now() - interval '2 minutes', not_before = now() - interval '2 minutes' WHERE task_id = ${fresh}::uuid`);
    const future = await seedTask(mine);
    await db.execute(sql`UPDATE task_dispatch_outbox SET created_at = now() - interval '10 minutes', not_before = now() + interval '1 hour' WHERE task_id = ${future}::uuid`);
    const takenBack = await seedTask(mine);
    await db.execute(sql`UPDATE task_dispatch_outbox SET created_at = now() - interval '10 minutes', not_before = now() - interval '10 minutes',
      metadata = jsonb_build_object('dispatchFallbackAt', now()::text) WHERE task_id = ${takenBack}::uuid`);
    const notDispatch = await seedTask(inApp);
    await db.execute(sql`UPDATE task_dispatch_outbox SET created_at = now() - interval '10 minutes', not_before = now() - interval '10 minutes' WHERE task_id = ${notDispatch}::uuid`);

    const team1 = await dispatchTeamHealth([mine, inApp]);
    const global1 = await dispatchOutboxHealth();
    expect(team1.unackedStale - team0.unackedStale).toBe(1);
    expect(global1.unackedStale - global0.unackedStale).toBe(1);
    // Fresh and future rows are still unacked, just not past the fallback.
    expect(team1.unacked - team0.unacked).toBe(3);
  }, DB_TIMEOUT_MS);

  test('no workspaces: zeros, no query', async () => {
    expect((await dispatchTeamHealth([])).pending).toBe(0);
  }, DB_TIMEOUT_MS);
});

describe('applyReceiptsDetailed', () => {
  test('returns the rows a batch moved to failed, once', async () => {
    const t = await seedTask(mine);
    const [row] = await handOff(t);
    const at = new Date().toISOString();
    const first = await applyReceiptsDetailed([{ id: row.id, attempt: 5, event: 'failed', why: 'http_500', at }]);
    expect(first.applied).toBe(1);
    expect(first.failed).toEqual([{ id: row.id, workspaceId: mine, error: 'http_500' }]);
    // A resend changes nothing and reports nothing: the alert cannot repeat from a retry.
    const again = await applyReceiptsDetailed([{ id: row.id, attempt: 5, event: 'failed', why: 'http_500', at }]);
    expect(again).toEqual({ applied: 0, failed: [] });
  }, DB_TIMEOUT_MS);

  test('a delivered receipt reports no failures', async () => {
    const t = await seedTask(mine);
    const [row] = await handOff(t);
    const r = await applyReceiptsDetailed([{ id: row.id, attempt: 1, event: 'delivered', via: 'webhook', at: new Date().toISOString() }]);
    expect(r).toEqual({ applied: 1, failed: [] });
  }, DB_TIMEOUT_MS);
});
