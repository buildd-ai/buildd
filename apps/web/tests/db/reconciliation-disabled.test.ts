/**
 * The architectural acceptance test (docs/specs/task-dispatch-authority.md):
 * normal work progresses with reconciliation switched off.
 *
 * Nothing here runs a cron route, a maintenance sweep, the dependency
 * backstop, the start_at backfill or a runner poll. The only thing that moves
 * a wake is `drainDispatchOutbox()` — exactly what `kickDispatch()` runs after
 * the request that made the change. If any of these flows needed a sweep to
 * reach a runner, the broadcast assertion would fail.
 *
 * Scope: the wake reaching runners. Whether the claim then runs or defers the
 * task is the claim route's job and is covered by its own tests.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';

type Sent = { channel: string; event: string; data: { task?: { id: string; dispatch?: { cause: string } } } };
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

const { db } = await import('@buildd/core/db');
const { releaseClaims, registerClaimDeferralWaiters } = await import('@buildd/core/path-claim');
const { enqueueReadyDependents } = await import('@buildd/core/dispatch-dependents');
const { drainDispatchOutbox } = await import('@/lib/dispatch-authority');
const { depsGate } = await import('@/app/api/workers/claim/deps-gate');
const { assertDbConfigured, seedTask, seedWorkspace } = await import('./harness');

let workspaceId: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});
beforeEach(() => { sent.length = 0; });

/** The kick: one drain, as after() runs it. Returns the causes each of `ids` was woken with. */
async function kick(...ids: string[]): Promise<Record<string, string[]>> {
  sent.length = 0;
  for (let i = 0; i < 10; i++) {
    const r = await drainDispatchOutbox({ limit: 200 });
    if (r.claimed === 0) break;
  }
  const out: Record<string, string[]> = Object.fromEntries(ids.map(id => [id, []]));
  for (const s of sent) {
    const t = s.data.task;
    if (s.event === 'task:assigned' && t && t.id in out) out[t.id].push(t.dispatch?.cause ?? '?');
  }
  return out;
}

const setStatus = (id: string, status: string) => db.execute(sql`UPDATE tasks SET status = ${status} WHERE id = ${id}::uuid`);

describe('with every reconciliation path disabled', () => {
  test('a created task reaches runners on the kick', async () => {
    const id = await seedTask(workspaceId);
    expect(await kick(id)).toEqual({ [id]: ['task.created'] });
  });

  test('a requeued task reaches runners on the kick', async () => {
    const id = await seedTask(workspaceId, { status: 'in_progress' });
    await kick(id);
    await setStatus(id, 'pending');
    expect(await kick(id)).toEqual({ [id]: ['task.requeued'] });
  });

  test('a task deferred for path overlap reaches runners when its blocker releases — not before', async () => {
    const holder = await seedTask(workspaceId, { status: 'in_progress' });
    const waiting = await seedTask(workspaceId, { pathManifest: ['e2e/shared.ts'] });
    await db.execute(sql`INSERT INTO path_claims (workspace_id, task_id, path) VALUES (${workspaceId}::uuid, ${holder}::uuid, 'e2e/shared.ts')`);
    await kick(waiting); // the creation wake; the claim would defer it

    await registerClaimDeferralWaiters(workspaceId, [{ waitingTaskId: waiting, blockingTaskId: holder, blockedPath: 'e2e/shared.ts' }]);
    expect(await kick(waiting)).toEqual({ [waiting]: [] });

    await setStatus(holder, 'completed');
    await releaseClaims(holder);
    expect(await kick(waiting)).toEqual({ [waiting]: ['path_claim.released'] });
  });

  test('a dependent reaches runners when its last dependency resolves — not before', async () => {
    const a = await seedTask(workspaceId, { status: 'in_progress' });
    const b = await seedTask(workspaceId, { status: 'in_progress' });
    const child = await seedTask(workspaceId, { dependsOn: [a, b] });
    await kick(child);

    await setStatus(a, 'completed');
    await enqueueReadyDependents(a, depsGate());
    expect(await kick(child)).toEqual({ [child]: [] });

    await setStatus(b, 'completed');
    await enqueueReadyDependents(b, depsGate());
    expect(await kick(child)).toEqual({ [child]: ['dependency.satisfied'] });
  });

  test('duplicate wakes for one task produce one broadcast per drain, and nothing is left pending', async () => {
    const id = await seedTask(workspaceId, { status: 'in_progress' });
    await kick(id);
    await setStatus(id, 'pending');
    const { enqueueDispatchSql } = await import('@buildd/core/dispatch-outbox');
    await db.execute(enqueueDispatchSql({ taskId: id, cause: 'ci.retry' }));
    await db.execute(enqueueDispatchSql({ taskId: id, cause: 'ci.retry' }));
    const woken = await kick(id);
    expect(woken[id]).toHaveLength(1);
    expect(woken[id][0]).toBe('ci.retry');
    expect(await kick(id)).toEqual({ [id]: [] });
  });

  test('a task claimed before delivery is not woken', async () => {
    const id = await seedTask(workspaceId);
    await setStatus(id, 'in_progress');
    expect(await kick(id)).toEqual({ [id]: [] });
  });
});
