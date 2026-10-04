/**
 * Path-claim release as a durable wake, against real Postgres.
 *
 * A pending task deferred for `path_overlap` must be re-evaluated the moment
 * its blocker lets go, not on a runner's fallback poll. The wake is an outbox
 * row written by the same statement that stamps the waiter, so it cannot be
 * lost between "released" and "told". These assert the SQL, which a mocked
 * `db` cannot see: which waiters a release stamps, which of them get an
 * intent (pending tasks only), and that a claim-time waiter registered after
 * its blocker already let go is woken at once instead of waiting forever.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import {
  findStaleClaimHolderTaskIds,
  narrowPathClaims,
  registerClaimDeferralWaiters,
  releaseLeaseRows,
  releaseClaims,
} from '@buildd/core/path-claim';
import { assertDbConfigured, outboxFor, q, seedTask, seedWorkspace } from './harness';

let workspaceId: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});

/** Close this test's own outbox rows only — the shared DB has other slices' rows. */
async function settle(...taskIds: string[]) {
  await db.execute(sql`UPDATE task_dispatch_outbox SET status = 'delivered', delivered_via = 'test:settled'
    WHERE task_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(taskIds)}::jsonb)::uuid)
      AND status IN ('pending', 'delivering')`);
}

/** Pending intents for a task that carry the path-release cause. */
async function releaseWakes(taskId: string) {
  return (await outboxFor(taskId)).filter(r => r.status === 'pending' && r.causes.includes('path_claim.released'));
}

async function lease(taskId: string, path: string) {
  await db.execute(sql`INSERT INTO path_claims (workspace_id, task_id, path) VALUES (${workspaceId}::uuid, ${taskId}::uuid, ${path})`);
}

async function waiter(blockingTaskId: string, waitingTaskId: string, blockedPath: string) {
  await db.execute(sql`INSERT INTO path_claim_waiters (workspace_id, blocking_task_id, waiting_task_id, blocked_path)
    VALUES (${workspaceId}::uuid, ${blockingTaskId}::uuid, ${waitingTaskId}::uuid, ${blockedPath})`);
}

async function waiterRows(waitingTaskId: string) {
  return q<{ blocking_task_id: string; blocked_path: string; notified_at: string | null }>(sql`
    SELECT blocking_task_id, blocked_path, notified_at FROM path_claim_waiters
    WHERE waiting_task_id = ${waitingTaskId}::uuid ORDER BY blocking_task_id`);
}

async function worker(taskId: string, opts: { status: string; prNumber?: number; mergedAt?: Date; lifecycle?: string }) {
  await db.execute(sql`INSERT INTO workers (task_id, workspace_id, name, runner, branch, status, pr_url, pr_number, merged_at, pr_lifecycle_status)
    VALUES (${taskId}::uuid, ${workspaceId}::uuid, 'w', 'test', 'b', ${opts.status},
      ${opts.prNumber ? `https://github.com/o/r/pull/${opts.prNumber}` : null}, ${opts.prNumber ?? null},
      ${opts.mergedAt?.toISOString() ?? null}::timestamptz, ${opts.lifecycle ?? null})`);
}

/** A running holder H and a pending waiter T, with T's creation wake already delivered. */
async function holderAndPendingWaiter(path = 'apps/web/a.ts') {
  const holder = await seedTask(workspaceId, { status: 'in_progress' });
  const waiting = await seedTask(workspaceId, { pathManifest: [path] });
  await settle(waiting);
  await lease(holder, path);
  return { holder, waiting };
}

describe('release wakes pending waiters in the same statement', () => {
  test('(a) releasing the holder writes a pending path_claim.released intent for the waiting task', async () => {
    const { holder, waiting } = await holderAndPendingWaiter();
    await waiter(holder, waiting, 'apps/web/a.ts');

    const result = await releaseClaims(holder);
    expect(result?.notifiedWaiters).toEqual([waiting]);
    const wakes = await releaseWakes(waiting);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ cause: 'path_claim.released', dedupe_key: 'now' });
  });

  test('(b) a waiter that is not pending gets no intent but is still returned for path_released delivery', async () => {
    const { holder } = await holderAndPendingWaiter();
    const running = await seedTask(workspaceId, { status: 'in_progress' });
    await waiter(holder, running, 'apps/web/a.ts');

    const result = await releaseClaims(holder);
    expect(result?.waiters).toEqual([{ waitingTaskId: running, blockedPath: 'apps/web/a.ts' }]);
    expect(await outboxFor(running)).toHaveLength(0);
  });

  test('(c) with two blockers, releasing one wakes the task but the other waiter stays pending', async () => {
    const a = await seedTask(workspaceId, { status: 'in_progress' });
    const b = await seedTask(workspaceId, { status: 'in_progress' });
    const waiting = await seedTask(workspaceId, { pathManifest: ['x/one.ts', 'x/two.ts'] });
    await settle(waiting);
    await lease(a, 'x/one.ts');
    await lease(b, 'x/two.ts');
    await waiter(a, waiting, 'x/one.ts');
    await waiter(b, waiting, 'x/two.ts');

    await releaseClaims(a);
    expect(await releaseWakes(waiting)).toHaveLength(1);
    const rows = await waiterRows(waiting);
    const onB = rows.find(r => r.blocking_task_id === b)!;
    const onA = rows.find(r => r.blocking_task_id === a)!;
    expect(onA.notified_at).not.toBeNull();
    // Still pending: the claim route re-defers it on B, and B's release wakes it again.
    expect(onB.notified_at).toBeNull();
  });

  test('(d) a narrowing that frees the waited-on path wakes the task; one that does not, does not', async () => {
    const holder = await seedTask(workspaceId, { status: 'in_progress', pathManifest: ['n/a.ts', 'n/b.ts'] });
    const freed = await seedTask(workspaceId, { pathManifest: ['n/a.ts'] });
    const stillBlocked = await seedTask(workspaceId, { pathManifest: ['n/b.ts'] });
    await settle(freed, stillBlocked);
    await lease(holder, 'n/a.ts');
    await lease(holder, 'n/b.ts');
    await waiter(holder, freed, 'n/a.ts');
    await waiter(holder, stillBlocked, 'n/b.ts');

    const result = await narrowPathClaims({ workspaceId, taskId: holder, paths: ['n/a.ts'], surface: 'test' });
    expect(result.kind).toBe('narrowed');
    expect(await releaseWakes(freed)).toHaveLength(1);
    expect(await releaseWakes(stillBlocked)).toHaveLength(0);
  });
  test('giving back a lost-claim lease wakes the task waiting on it', async () => {
    const { holder, waiting } = await holderAndPendingWaiter('l/lease.ts');
    await waiter(holder, waiting, 'l/lease.ts');
    const [row] = await q<{ id: string }>(sql`SELECT id FROM path_claims WHERE task_id = ${holder}::uuid`);
    const out = await releaseLeaseRows({ workspaceId, taskId: holder, leaseIds: [row.id], keepStatuses: [] });
    expect(out.kind).toBe('released');
    expect(await releaseWakes(waiting)).toHaveLength(1);
  });
});

describe('claim-time waiter registration', () => {
  test('a deferral behind a held lease registers a pending waiter and writes no intent', async () => {
    const { holder, waiting } = await holderAndPendingWaiter('r/held.ts');
    const out = await registerClaimDeferralWaiters(workspaceId, [{ waitingTaskId: waiting, blockingTaskId: holder, blockedPath: 'r/held.ts' }]);
    expect(out.woken).toEqual([]);
    expect(await waiterRows(waiting)).toEqual([{ blocking_task_id: holder, blocked_path: 'r/held.ts', notified_at: null }]);
    expect(await releaseWakes(waiting)).toHaveLength(0);

    // And the holder's release then wakes it — the bug this closes.
    await releaseClaims(holder);
    expect(await releaseWakes(waiting)).toHaveLength(1);
  });

  test('(e) registering behind a blocker that already holds nothing wakes the task immediately', async () => {
    const { holder, waiting } = await holderAndPendingWaiter('r/gone.ts');
    // The blocker lets go between the claim route's read and the registration.
    await releaseClaims(holder);
    expect(await releaseWakes(waiting)).toHaveLength(0);

    const out = await registerClaimDeferralWaiters(workspaceId, [{ waitingTaskId: waiting, blockingTaskId: holder, blockedPath: 'r/gone.ts' }]);
    expect(out.woken).toEqual([waiting]);
    expect(await releaseWakes(waiting)).toHaveLength(1);
    // Not left as a silent pending waiter.
    expect((await waiterRows(waiting))[0].notified_at).not.toBeNull();
  });

  test('a blocker with an open PR still blocks even with no lease left (layer 1)', async () => {
    const blocker = await seedTask(workspaceId, { status: 'completed', pathManifest: ['p/open.ts'] });
    await worker(blocker, { status: 'completed', prNumber: 101 });
    const waiting = await seedTask(workspaceId, { pathManifest: ['p/open.ts'] });
    await settle(waiting);

    const out = await registerClaimDeferralWaiters(workspaceId, [{ waitingTaskId: waiting, blockingTaskId: blocker, blockedPath: 'p/open.ts' }]);
    expect(out.woken).toEqual([]);
    expect((await waiterRows(waiting))[0].notified_at).toBeNull();

    // The merge webhook stamps merged_at and then releases: that wakes it.
    await db.execute(sql`UPDATE workers SET merged_at = now() WHERE task_id = ${blocker}::uuid`);
    await releaseClaims(blocker);
    expect(await releaseWakes(waiting)).toHaveLength(1);
  });

  test('a blocker whose PR merged or closed no longer blocks', async () => {
    const merged = await seedTask(workspaceId, { status: 'completed' });
    await worker(merged, { status: 'completed', prNumber: 102, mergedAt: new Date() });
    const closed = await seedTask(workspaceId, { status: 'completed' });
    await worker(closed, { status: 'completed', prNumber: 103, lifecycle: 'closed' });
    const w1 = await seedTask(workspaceId, { pathManifest: ['p/m.ts'] });
    const w2 = await seedTask(workspaceId, { pathManifest: ['p/c.ts'] });
    await settle(w1, w2);

    const out = await registerClaimDeferralWaiters(workspaceId, [
      { waitingTaskId: w1, blockingTaskId: merged, blockedPath: 'p/m.ts' },
      { waitingTaskId: w2, blockingTaskId: closed, blockedPath: 'p/c.ts' },
    ]);
    expect(out.woken.sort()).toEqual([w1, w2].sort());
  });

  test('a lease on a parent directory still blocks the child path', async () => {
    const holder = await seedTask(workspaceId, { status: 'in_progress' });
    await lease(holder, 'dir/sub');
    const waiting = await seedTask(workspaceId, { pathManifest: ['dir/sub/file.ts'] });
    await settle(waiting);
    const out = await registerClaimDeferralWaiters(workspaceId, [{ waitingTaskId: waiting, blockingTaskId: holder, blockedPath: 'dir/sub' }]);
    expect(out.woken).toEqual([]);
  });

  test('re-registering a notified waiter re-arms it', async () => {
    const { holder, waiting } = await holderAndPendingWaiter('r/rearm.ts');
    await waiter(holder, waiting, 'r/rearm.ts');
    await db.execute(sql`UPDATE path_claim_waiters SET notified_at = now() WHERE waiting_task_id = ${waiting}::uuid`);

    await registerClaimDeferralWaiters(workspaceId, [{ waitingTaskId: waiting, blockingTaskId: holder, blockedPath: 'r/rearm.ts' }]);
    expect((await waiterRows(waiting))[0].notified_at).toBeNull();
  });

  test('entries naming a task outside the workspace are ignored', async () => {
    const other = await seedWorkspace();
    const foreignHolder = await seedTask(other.workspaceId, { status: 'in_progress' });
    const waiting = await seedTask(workspaceId, { pathManifest: ['f/x.ts'] });
    await settle(waiting);
    const out = await registerClaimDeferralWaiters(workspaceId, [{ waitingTaskId: waiting, blockingTaskId: foreignHolder, blockedPath: 'f/x.ts' }]);
    expect(out).toEqual({ registered: 0, woken: [] });
    expect(await waiterRows(waiting)).toEqual([]);
  });

  test('an empty batch writes nothing', async () => {
    expect(await registerClaimDeferralWaiters(workspaceId, [])).toEqual({ registered: 0, woken: [] });
  });
});

describe('maintenance sweep backstop', () => {
  test('a terminal blocker with a pending claim-time waiter is found for repair', async () => {
    const blocker = await seedTask(workspaceId, { status: 'failed' });
    await worker(blocker, { status: 'failed' });
    const waiting = await seedTask(workspaceId, { pathManifest: ['s/a.ts'] });
    await waiter(blocker, waiting, 's/a.ts');
    expect(await findStaleClaimHolderTaskIds()).toContain(blocker);
  });

  test('a completed blocker whose PR is still open is NOT repaired — it is still blocking', async () => {
    const blocker = await seedTask(workspaceId, { status: 'completed' });
    await worker(blocker, { status: 'completed', prNumber: 104 });
    const waiting = await seedTask(workspaceId, { pathManifest: ['s/b.ts'] });
    await waiter(blocker, waiting, 's/b.ts');
    expect(await findStaleClaimHolderTaskIds()).not.toContain(blocker);
  });
});
