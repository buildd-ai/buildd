/**
 * The startAt timer, against real Postgres: a task deferred to a future time
 * is woken at that time by the outbox drain alone — no reconciliation sweep,
 * no other process. Contract: docs/specs/task-dispatch-authority.md.
 *
 * The drain is global, so it may deliver rows other files seeded; every
 * assertion here filters by this file's own task ids.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';

type Sent = { channel: string; event: string; data: { task?: { id?: string; dispatch?: { id: string; cause: string } } } };
const sent: Sent[] = [];
const record = async (channel: string, event: string, data: unknown) => {
  sent.push({ channel, event, data: data as Sent['data'] });
};
// The real module's whole surface: mock.module is process-global.
mock.module('@/lib/pusher', () => ({
  _resetPusher: () => {},
  triggerEvent: record,
  triggerEventChecked: async (channel: string, event: string, data: unknown) => {
    await record(channel, event, data);
    return 'sent' as const;
  },
  channels: {
    workspace: (id: string) => `workspace-${id}`,
    task: (id: string) => `task-${id}`,
    worker: (id: string) => `worker-${id}`,
    mission: (id: string) => `mission-${id}`,
    conversation: (id: string) => `conversation-${id}`,
  },
  events: new Proxy({ TASK_ASSIGNED: 'task:assigned', TASK_CREATED: 'task:created' } as Record<string, string>, {
    get: (target, key: string) => target[key] ?? key,
  }),
}));

const { drainDispatchOutbox } = await import('@/lib/dispatch-authority');
const { backfillStartAtWakes } = await import('@/lib/dispatch-repair');
const { assertDbConfigured, outboxFor, seedTask, seedWorkspace } = await import('./harness');

let workspaceId: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});

const assignedFor = (taskId: string) =>
  sent.filter(s => s.event === 'task:assigned' && s.data.task?.id === taskId);

/** Drain until `taskId`'s row leaves pending, or give up. Other files' rows may share a batch. */
async function drainUntilDelivered(taskId: string, rowId: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await drainDispatchOutbox();
    const row = (await outboxFor(taskId)).find(r => r.id === rowId);
    if (row && row.status !== 'pending' && row.status !== 'delivering') return;
  }
}

describe('startAt timer', () => {
  test('a future startAt is not delivered early, and is delivered once due with no other process involved', async () => {
    // Real time, not a simulated clock: delivery re-checks tasks.start_at, and
    // moving it would fire the trigger again and muddy which row did the work.
    const due = new Date(Date.now() + 2_500);
    const taskId = await seedTask(workspaceId, { startAt: due });
    const [row] = await outboxFor(taskId);
    expect(row).toMatchObject({ cause: 'start_at.reached', status: 'pending', dedupe_key: `start_at:${due.getTime()}` });

    await drainDispatchOutbox();
    expect((await outboxFor(taskId)).find(r => r.id === row.id)?.status).toBe('pending');
    expect(assignedFor(taskId)).toHaveLength(0);

    await Bun.sleep(Math.max(0, due.getTime() - Date.now()) + 300);
    await drainUntilDelivered(taskId, row.id);

    const after = (await outboxFor(taskId)).find(r => r.id === row.id);
    expect(after).toMatchObject({ status: 'delivered', delivered_via: 'pusher', attempt_count: 1 });
    const broadcasts = assignedFor(taskId);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].channel).toBe(`workspace-${workspaceId}`);
    expect(broadcasts[0].data.task?.dispatch).toEqual({ id: row.id, cause: 'start_at.reached' });
  });

  test('an intent due before the task\'s startAt is skipped, not broadcast', async () => {
    // The outbox row and the task disagree (a timer fired early): delivery
    // trusts the task, so nothing is sent before the claim would accept it.
    const taskId = await seedTask(workspaceId, { startAt: new Date(Date.now() + 3_600_000) });
    const [row] = await outboxFor(taskId);
    await db.execute(sql`UPDATE task_dispatch_outbox SET not_before = now() - interval '1 second' WHERE id = ${row.id}::uuid`);
    await drainUntilDelivered(taskId, row.id);
    const after = (await outboxFor(taskId)).find(r => r.id === row.id);
    expect(after).toMatchObject({ status: 'delivered', delivered_via: 'skipped:start_at_future' });
    expect(assignedFor(taskId)).toHaveLength(0);
  });
});

describe('floor-tick backfill for tasks deferred before the outbox existed', () => {
  test('re-creates the scheduled wake a pre-outbox task never got, exactly once', async () => {
    const due = new Date(Date.now() + 3_600_000);
    const taskId = await seedTask(workspaceId, { startAt: due });
    // Simulate a task deferred before the trigger: no intent at all.
    await db.execute(sql`DELETE FROM task_dispatch_outbox WHERE task_id = ${taskId}::uuid`);

    await backfillStartAtWakes();
    const rows = await outboxFor(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cause: 'start_at.reached', status: 'pending', dedupe_key: `start_at:${due.getTime()}` });
    expect(Math.abs(new Date(rows[0].not_before).getTime() - due.getTime())).toBeLessThan(1000);

    await backfillStartAtWakes();
    expect(await outboxFor(taskId)).toHaveLength(1);
  });

  test('leaves a task the trigger already scheduled alone', async () => {
    const taskId = await seedTask(workspaceId, { startAt: new Date(Date.now() + 3_600_000) });
    await backfillStartAtWakes();
    expect(await outboxFor(taskId)).toHaveLength(1);
  });

  test('does not re-create a wake that was already delivered', async () => {
    const taskId = await seedTask(workspaceId, { startAt: new Date(Date.now() + 3_600_000) });
    await db.execute(sql`UPDATE task_dispatch_outbox SET status = 'delivered', delivered_via = 'test' WHERE task_id = ${taskId}::uuid`);
    await backfillStartAtWakes();
    expect((await outboxFor(taskId)).map(r => r.status)).toEqual(['delivered']);
  });

  test('ignores tasks that are not pending or whose startAt has passed', async () => {
    const notPending = await seedTask(workspaceId, { status: 'completed', startAt: new Date(Date.now() + 3_600_000) });
    const passed = await seedTask(workspaceId, { startAt: new Date(Date.now() - 60_000) });
    await db.execute(sql`DELETE FROM task_dispatch_outbox WHERE task_id IN (${notPending}::uuid, ${passed}::uuid)`);
    await backfillStartAtWakes();
    expect(await outboxFor(notPending)).toHaveLength(0);
    expect(await outboxFor(passed)).toHaveLength(0);
  });
});
