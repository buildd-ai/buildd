/**
 * Adversarial probe, lens 2 (concurrency): CAS on the delivery row, the
 * effect outbox's lease, and check-then-act races between two requests.
 * Real kernel, real Postgres (neon-http shim), stateful fake GitHub.
 *
 * Each `FINDING` test asserts the CORRECT behaviour and fails on origin/dev.
 * `CONTROL` tests probe races the kernel does handle; they pass.
 *
 * Every finding test asserts the CORRECT behaviour and is marked `test.failing`
 * because it fails on dev today (probe task e769323f). Bun reports a
 * `test.failing` that starts passing as a failure, so the PR that fixes a
 * finding must turn its test(s) back into plain `test`.
 */
import { mock } from 'bun:test';

// Count the one fan-out a merge makes (emit_pr_merged → task.pr_merged), before anything loads it.
const emitted: Array<{ type: string; taskId?: string }> = [];
mock.module('../../src/lib/core-emit', () => ({
  emit: async (event: { type: string; taskId?: string }) => { emitted.push({ type: event.type, taskId: event.taskId }); },
}));

import { afterEach, describe, expect, test } from 'bun:test';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '@buildd/core/db';
import { q, seedTask } from './harness';
import { seam, world, type World } from './workflow-scenarios-world';

const { runEffects } = await import('../../src/lib/workflow/effects');
const { withPrFactEffects } = await import('../../src/lib/workflow/pr-fact-effects');
const modules = await import('../../src/modules');
type Exec = import('../../src/lib/workflow/kernel').Exec;
type EffectHandlers = import('../../src/lib/workflow/effects').EffectHandlers;
type ClaimedEffect = import('../../src/lib/workflow/effects').ClaimedEffect;

const dialect = new PgDialect();
const { appendFileSync } = await import('node:fs');
/** The db-test runner swallows console output; findings' evidence goes to PROBE_LOG. */
const note = (...parts: unknown[]): void => {
  const line = parts.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  if (process.env.PROBE_LOG) appendFileSync(process.env.PROBE_LOG, `${line}\n`);
  else console.error(line);
};
const dbExec: Exec = (query) => db.execute(query) as unknown as Promise<{ rows?: unknown[] }>;
const textOf = (query: SQL): string => dialect.sqlToQuery(query).sql;

let w: World;
afterEach(() => w?.dispose());

const realHandlers = (): EffectHandlers => withPrFactEffects(modules.workflowEffectHandlers());

// ─────────────────────────────────────────────────────────────────────────────
// FINDING 1: applyCommand gives up after one CAS retry and the callers drop it.
// ─────────────────────────────────────────────────────────────────────────────
describe('FINDING: a command that loses the CAS race twice is dropped, and nothing re-derives it', () => {
  test('owner attempt ends while two other writes land on the delivery → the hand-on is applied (not stranded in WORKING)', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/cas-twice', files: { 'src/a.ts': 'export const a = 2;\n' } });
    expect((await w.delivery(pr)).state).toBe('WORKING');

    // Two version-bumping writes (a collaborator's pushes, each handled by its synchronize
    // webhook) land between AttemptEnded's read and its version-guarded write, twice.
    let injected = 0;
    const exec: Exec = async (query) => {
      if (textOf(query).startsWith('-- workflow:transition') && injected < 2) {
        injected++;
        w.gh.push(w.repo, pr.branch, { [`src/c${injected}.ts`]: `export const c = ${injected};\n` }, { pusher: 'dev' });
        await w.deliver();
      }
      return dbExec(query);
    };
    await q(sql`UPDATE workers SET status = 'completed' WHERE id = ${pr.workerId}::uuid`);
    await q(sql`UPDATE tasks SET status = 'completed' WHERE id = ${pr.ownerTaskId}::uuid`);
    const ended = await seam.attemptEnded({
      task: { id: pr.ownerTaskId, workspaceId: w.workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'owner', context: null },
      workerId: pr.workerId, status: 'completed', localHeadSha: pr.head, commitCount: 1, source: 'runner',
    }, { exec });
    expect(injected).toBe(2);
    // What the runner PATCH does with this answer: logs it (seam.ts attemptEnded) and moves on.
    note('[probe] AttemptEnded answered', ended.result?.result, (ended.result as { reason?: string })?.reason);

    // The cron floor runs, as it would every few minutes; nothing else ever re-sends an owner end.
    await w.floor(pr);
    await w.floor(pr);
    const d = await w.delivery(pr);
    expect(await w.commands(pr)).toContain('AttemptEnded');
    expect(d.state).not.toBe('WORKING');
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// FINDING 2: a batch shares one lease; serial handlers outlive it; acks are unfenced.
// ─────────────────────────────────────────────────────────────────────────────
describe('FINDING: an effect claimed in a batch whose lease runs out mid-batch is executed twice', () => {
  async function mergedWithEffectsPending(branch: string) {
    w = await world();
    const pr = await w.openPr({ branch, files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    // A person merges on GitHub; the closed webhook is handled but its inline drain is lost
    // (function killed / timed out): the post-merge effects wait for the cron drain.
    w.gh.mergePr(w.repo, pr.prNumber);
    await seam.observePrState({ workspaceId: w.workspaceId, repoFullName: w.repo, prNumber: pr.prNumber, installationId: w.installationId, source: 'webhook:closed' }, { drain: async () => null });
    expect((await w.delivery(pr)).state).toBe('MERGED');
    return pr;
  }

  test.failing('cron drain A claims the post-merge batch; its first handler takes >120s; drain B re-claims the rest → emit_pr_merged runs once (one task.pr_merged)', async () => {
    const pr = await mergedWithEffectsPending('feat/lease-batch');
    emitted.length = 0;
    const base = realHandlers();
    const runs = new Map<string, number>();
    const count = (h: EffectHandlers): EffectHandlers => Object.fromEntries(Object.entries(h).map(([k, fn]) => [k, async (e: ClaimedEffect) => {
      runs.set(`${e.kind}:${e.id}`, (runs.get(`${e.kind}:${e.id}`) ?? 0) + 1);
      return fn!(e);
    }])) as EffectHandlers;
    const forB = count(base);
    let slow = true;
    const forA: EffectHandlers = Object.fromEntries(Object.entries(count(base)).map(([k, fn]) => [k, async (e: ClaimedEffect) => {
      if (slow) {
        slow = false;
        // This handler is slow (a GitHub call, a reviewer context build, a cold Neon): 120s pass.
        // Modelled by moving the batch's leases into the past, which is what the clock does.
        await q(sql`UPDATE workflow_effects SET lease_until = now() - interval '1 second' WHERE delivery_id = ${pr.deliveryId}::uuid AND status = 'delivering'`);
        // The next cron tick (or any webhook's inline drain) runs meanwhile.
        const b = await runEffects({ handlers: forB, deliveryId: pr.deliveryId, limit: 25 });
        note('[probe] drain B (while A is still running):', JSON.stringify({ claimed: b.claimed, done: b.done, skipped: b.skipped }));
      }
      return fn!(e);
    }])) as EffectHandlers;
    const a = await runEffects({ handlers: forA, deliveryId: pr.deliveryId, limit: 25 });
    note('[probe] drain A:', JSON.stringify({ claimed: a.claimed, done: a.done, skipped: a.skipped }), 'handler runs:', JSON.stringify([...runs]));
    const prMerged = emitted.filter((e) => e.type === 'task.pr_merged');
    const twice = [...runs].filter(([, n]) => n > 1).map(([k]) => k.split(':')[0]);
    note('[probe] effects executed twice:', twice.join(', ') || 'none', `; task.pr_merged emitted ${prMerged.length}x`);
    expect(twice).toEqual([]);
    expect(prMerged).toHaveLength(1);
  });

  test.failing('unfenced ack: A completes an effect B re-claimed and failed meanwhile → A\'s ack is a no-op, the row stays pending and the effect runs a third time', async () => {
    const pr = await mergedWithEffectsPending('feat/lease-ack');
    const base = realHandlers();
    // B's run of finalize_mission_pr fails (GitHub 5xx); A's run (the stale one) succeeded first.
    let slow = true;
    let bFailed = false;
    const forB: EffectHandlers = { ...base, finalize_mission_pr: async () => { bFailed = true; throw new Error('GitHub 502 on branch delete'); } };
    const forA: EffectHandlers = Object.fromEntries(Object.entries(base).map(([k, fn]) => [k, async (e: ClaimedEffect) => {
      if (slow) {
        slow = false;
        await q(sql`UPDATE workflow_effects SET lease_until = now() - interval '1 second' WHERE delivery_id = ${pr.deliveryId}::uuid AND status = 'delivering'`);
        // B re-claims everything A holds; B's finalize fails and is re-queued (pending, backoff)...
        await runEffects({ handlers: forB, deliveryId: pr.deliveryId, limit: 25 });
      }
      return fn!(e);
    }])) as EffectHandlers;
    await runEffects({ handlers: forA, deliveryId: pr.deliveryId, limit: 25 });
    const [fin] = await q<{ status: string; attempt_count: number; last_error: string | null; outcome: string | null }>(
      sql`SELECT status, attempt_count, last_error, outcome FROM workflow_effects WHERE delivery_id = ${pr.deliveryId}::uuid AND kind = 'finalize_mission_pr'`);
    note('[probe] finalize_mission_pr row after both drains:', JSON.stringify(fin), 'B failed:', bFailed);
    // Each attempt must answer for itself: A's ack cannot settle B's attempt, nor B's fail re-open A's.
    // Today an unfenced ack/fail (WHERE status = 'delivering') settles whichever attempt holds the row.
    expect(bFailed).toBe(true);
    expect(fin.attempt_count).toBe(2);
    // A ran AFTER B failed and B re-queued it, so A's ack found status='pending' and did nothing:
    // the effect A really completed is run a THIRD time later. Either way the row's outcome is not A's.
    expect(fin.status).toBe('done');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FINDING 3: late PR open vs the runner's completion PATCH (check-then-act on two rows).
// ─────────────────────────────────────────────────────────────────────────────
describe('FINDING: the owner finishes while its PR is being opened → nobody hands the delivery on', () => {
  test('PATCH reads task.deliveryId (null) → opened webhook opens the delivery (worker still running) → PATCH writes completed and skips AttemptEnded → delivery leaves WORKING', async () => {
    w = await world();
    const ownerTaskId = await seedTask(w.workspaceId, { status: 'in_progress', title: 'feat: late open' });
    const branch = 'feat/late-open';
    w.gh.createBranch(w.repo, branch, 'dev');
    const head = w.gh.push(w.repo, branch, { 'src/a.ts': 'export const a = 3;\n' });
    const prNumber = w.gh.openPr(w.repo, { head: branch, base: 'dev', title: 'feat: late open' });
    const [wk] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, pr_number, pr_url, commit_count)
      VALUES (${w.workspaceId}::uuid, ${ownerTaskId}::uuid, 'w', 'test', ${branch}, 'running', ${head}, ${prNumber}, ${`https://github.com/${w.repo}/pull/${prNumber}`}, 1) RETURNING id`);

    // 1. Runner PATCH {status: completed}: route.ts reads the task row (terminalTaskRow, incl. deliveryId) up front.
    const [patchRead] = await q<{ delivery_id: string | null }>(sql`SELECT delivery_id FROM tasks WHERE id = ${ownerTaskId}::uuid`);
    expect(patchRead.delivery_id).toBeNull();

    // 2. Meanwhile the pull_request.opened webhook: openKernelDelivery binds the PR, sets
    //    tasks.delivery_id, then checks the latest worker: still 'running' → no late hand-off.
    const opened = await seam.openKernelDelivery({ workspaceId: w.workspaceId, ownerTaskId, repoFullName: w.repo, prNumber, installationId: w.installationId, source: 'webhook:opened' });
    expect(opened.owned).toBe(true);

    // 3. The PATCH carries on: worker and task go terminal...
    await q(sql`UPDATE workers SET status = 'completed' WHERE id = ${wk.id}::uuid`);
    await q(sql`UPDATE tasks SET status = 'completed' WHERE id = ${ownerTaskId}::uuid`);
    // 4. ...and its workflow-attempt-ended step returns early on terminalTaskRow.deliveryId == null.
    //    (route.ts: `if (!row?.deliveryId || ...) return;`)

    // The floor runs; then again.
    await seam.reconcileKernelDeliveries({}, { only: [opened.deliveryId!], minQuietMs: 0 });
    await seam.reconcileKernelDeliveries({}, { only: [opened.deliveryId!], minQuietMs: 0 });
    const [d] = await q<{ state: string }>(sql`SELECT state FROM workflow_deliveries WHERE id = ${opened.deliveryId!}::uuid`);
    const [rev] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM tasks WHERE delivery_id = ${opened.deliveryId!}::uuid AND delivery_role = 'review'`);
    note('[probe] late-open race: delivery state', d.state, 'reviewer tasks', rev.n);
    expect(d.state).not.toBe('WORKING');
  });
});

describe('FINDING: the owner finishes while its PR is being opened (whole PATCH inside the open)', () => {
  test('opened webhook reads the owner task (in_progress) → the whole completion PATCH runs (deliveryId still null) → open binds and checks the worker with its stale task status → delivery leaves WORKING', async () => {
    w = await world();
    const ownerTaskId = await seedTask(w.workspaceId, { status: 'in_progress', title: 'feat: late open 2' });
    const branch = 'feat/late-open-2';
    w.gh.createBranch(w.repo, branch, 'dev');
    const head = w.gh.push(w.repo, branch, { 'src/a.ts': 'export const a = 4;\n' });
    const prNumber = w.gh.openPr(w.repo, { head: branch, base: 'dev', title: 'feat: late open 2' });
    const [wk] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, pr_number, pr_url, commit_count)
      VALUES (${w.workspaceId}::uuid, ${ownerTaskId}::uuid, 'w', 'test', ${branch}, 'running', ${head}, ${prNumber}, ${`https://github.com/${w.repo}/pull/${prNumber}`}, 1) RETURNING id`);

    // openKernelDelivery has already read the task row (status in_progress) when the runner's
    // completion PATCH arrives; it runs to the end while the open does its GitHub reads.
    let patchSawDeliveryId: string | null | undefined;
    const exec: Exec = async (query) => {
      if (patchSawDeliveryId === undefined && textOf(query).startsWith('-- workflow:transition')) {
        const [row] = await q<{ delivery_id: string | null }>(sql`SELECT delivery_id FROM tasks WHERE id = ${ownerTaskId}::uuid`);
        patchSawDeliveryId = row.delivery_id;
        await q(sql`UPDATE workers SET status = 'completed' WHERE id = ${wk.id}::uuid`);
        await q(sql`UPDATE tasks SET status = 'completed' WHERE id = ${ownerTaskId}::uuid`);
        // route.ts workflow-attempt-ended: `if (!row?.deliveryId ...) return;`
      }
      return dbExec(query);
    };
    const opened = await seam.openKernelDelivery({ workspaceId: w.workspaceId, ownerTaskId, repoFullName: w.repo, prNumber, installationId: w.installationId, source: 'webhook:opened' }, { exec });
    expect(opened.owned).toBe(true);
    expect(patchSawDeliveryId).toBeNull();

    await seam.reconcileKernelDeliveries({}, { only: [opened.deliveryId!], minQuietMs: 0 });
    const [d] = await q<{ state: string }>(sql`SELECT state FROM workflow_deliveries WHERE id = ${opened.deliveryId!}::uuid`);
    const [t] = await q<{ status: string }>(sql`SELECT status FROM tasks WHERE id = ${ownerTaskId}::uuid`);
    note('[probe] late-open race (PATCH inside open): delivery', d.state, 'owner task', t.status);
    expect(d.state).not.toBe('WORKING');
  });
});

describe('FINDING: a crash between the kernel taking the PR and stamping tasks.delivery_id', () => {
  test('openKernelDelivery commits T1/T2/T3, then the function dies before `UPDATE tasks SET delivery_id` → the owner later completes normally → delivery leaves WORKING', async () => {
    w = await world();
    const ownerTaskId = await seedTask(w.workspaceId, { status: 'in_progress', title: 'feat: crash mid-open' });
    const branch = 'feat/crash-open';
    w.gh.createBranch(w.repo, branch, 'dev');
    const head = w.gh.push(w.repo, branch, { 'src/a.ts': 'export const a = 5;\n' });
    const prNumber = w.gh.openPr(w.repo, { head: branch, base: 'dev', title: 'feat: crash mid-open' });
    const [wk] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, pr_number, pr_url, commit_count)
      VALUES (${w.workspaceId}::uuid, ${ownerTaskId}::uuid, 'w', 'test', ${branch}, 'running', ${head}, ${prNumber}, ${`https://github.com/${w.repo}/pull/${prNumber}`}, 1) RETURNING id`);
    let transitions = 0;
    const exec: Exec = async (query) => {
      const res = await dbExec(query);
      if (textOf(query).startsWith('-- workflow:transition') && ++transitions === 3) throw new Error('FUNCTION_INVOCATION_TIMEOUT (injected)');
      return res;
    };
    await expect(seam.openKernelDelivery({ workspaceId: w.workspaceId, ownerTaskId, repoFullName: w.repo, prNumber, installationId: w.installationId, source: 'webhook:opened' }, { exec })).rejects.toThrow(/injected/);
    const owned = await seam.kernelDeliveryOfPr({ workspaceId: w.workspaceId, prNumber });
    expect(owned?.deliveryId).toBeTruthy(); // the kernel owns the PR: legacy review doors now refuse it

    // Later: the owner's completion PATCH. route.ts forwards the end to the kernel only via tasks.delivery_id.
    const [row] = await q<{ delivery_id: string | null }>(sql`SELECT delivery_id FROM tasks WHERE id = ${ownerTaskId}::uuid`);
    await q(sql`UPDATE workers SET status = 'completed' WHERE id = ${wk.id}::uuid`);
    await q(sql`UPDATE tasks SET status = 'completed' WHERE id = ${ownerTaskId}::uuid`);
    if (row.delivery_id) {
      await seam.attemptEnded({ task: { id: ownerTaskId, workspaceId: w.workspaceId, deliveryId: row.delivery_id, deliveryRole: 'owner', context: null },
        workerId: wk.id, status: 'completed', localHeadSha: head, commitCount: 1, source: 'runner' });
    }
    await seam.reconcileKernelDeliveries({}, { only: [owned!.deliveryId], minQuietMs: 0 });
    const [d] = await q<{ state: string }>(sql`SELECT state FROM workflow_deliveries WHERE id = ${owned!.deliveryId}::uuid`);
    note('[probe] crash mid-open: tasks.delivery_id', row.delivery_id, 'delivery', d.state);
    expect(d.state).not.toBe('WORKING');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// CONTROLS: races the kernel does handle.
// ─────────────────────────────────────────────────────────────────────────────
describe('CONTROL: races the kernel handles', () => {
  test('the same synchronize webhook delivered twice, concurrently → one HeadObserved, one dispatch_review, one reviewer', async () => {
    const RUNS = Number(process.env.PROBE_RUNS ?? 10);
    for (let i = 0; i < RUNS; i++) {
      w = await world({ seed: 300 + i });
      const pr = await w.openPr({ branch: `feat/dup-sync-${i}`, files: { 'src/a.ts': 'export const a = 2;\n' } });
      await w.approve(pr);
      w.gh.push(w.repo, pr.branch, { 'src/a.ts': 'export const a = 9;\n' }, { pusher: 'dev' });
      const sync = structuredClone(w.gh.pendingWebhooks().find((d) => d.name === 'pull_request' && (d.payload as { action?: string }).action === 'synchronize')!);
      w.gh.discardWebhooks();
      await Promise.all([w.ingest(sync), w.ingest(sync), w.ingest(sync)]);
      const heads = (await w.commands(pr)).filter((c) => c === 'HeadObserved');
      const rounds = (await w.effects(pr)).filter((e) => e.kind === 'dispatch_review');
      expect(heads.length).toBeGreaterThanOrEqual(1);
      expect(rounds.map((e) => e.dedupe_key).length).toBe(new Set(rounds.map((e) => e.dedupe_key)).size);
      expect((await w.tasksOf(pr, 'review')).filter((t) => t.status === 'pending')).toHaveLength(1);
      w.dispose();
    }
  }, 300_000);

  test('three merge doors land the same approved head at once → exactly one merge call, one PrMerged', async () => {
    const RUNS = Number(process.env.PROBE_RUNS ?? 10);
    for (let i = 0; i < RUNS; i++) {
      w = await world({ seed: 700 + i });
      const pr = await w.openPr({ branch: `feat/land-race-${i}`, files: { 'src/a.ts': 'export const a = 2;\n' } });
      await w.approve(pr);
      const h = w.gh.pr(w.repo, pr.prNumber).headSha;
      await Promise.all([w.land(pr, h), w.land(pr, h), w.land(pr, h)]);
      await w.deliver();
      expect(w.mergeCalls(pr).filter((c) => c.status === 200)).toHaveLength(1);
      expect(w.mergeCalls(pr)).toHaveLength(1);
      expect((await w.commands(pr)).filter((c) => c === 'PrMerged')).toHaveLength(1);
      w.dispose();
    }
  }, 300_000);

  test('two drains of the same due effects at once → every effect runs once (SKIP LOCKED)', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/two-drains', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    w.gh.mergePr(w.repo, pr.prNumber);
    await seam.observePrState({ workspaceId: w.workspaceId, repoFullName: w.repo, prNumber: pr.prNumber, installationId: w.installationId, source: 'webhook:closed' }, { drain: async () => null });
    const base = realHandlers();
    const runs = new Map<string, number>();
    const counted = Object.fromEntries(Object.entries(base).map(([k, fn]) => [k, async (e: ClaimedEffect) => {
      runs.set(e.id, (runs.get(e.id) ?? 0) + 1);
      return fn!(e);
    }])) as EffectHandlers;
    await Promise.all([1, 2, 3].map(() => runEffects({ handlers: counted, deliveryId: pr.deliveryId, limit: 25 })));
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
  });
});
