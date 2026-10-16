/**
 * S4a review on real Postgres (docs/specs/workflow-kernel-library.md §1): a delivery-owned PR's
 * merge must not wait an hour when its webhook is lost or the kernel's live read fails, and a
 * merge the state machine cannot take (after ABANDONED / SUPERSEDED) is recorded loudly.
 *
 *  - Worst case 1, the webhook never arrives: the dependency gate's live read hands the merge to
 *    the kernel (T17) in the same call, and answers true only because the row now carries it.
 *  - Worst case 2, the webhook arrives but the kernel's own read fails: the webhook's payload is
 *    recorded unapplied, a fast heal is queued, and the next per-minute tick applies it.
 *  - The floor never starves: an unapplied merge goes first, checked rows rotate, legacy is skipped.
 *  - AC-4: a merge after ABANDONED changes no worker column; the fact carries the contradiction,
 *    a notice is queued and the delivery's view (what explain reads) says so.
 *
 * GitHub, Redis and the effect drain are faked; every statement is real.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import type { LivePr } from '../../src/lib/workflow/commands';
import type { GithubFactReader } from '../../src/lib/workflow/facts';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const REPO = 'acme/heal';
let workspaceId: string;
let prSeq = 100_000 + Math.floor(Math.random() * 800_000);

interface FakePr { head: string; state: 'open' | 'closed'; merged: boolean; updatedAt: string }
let gh: FakePr;
/** The kernel's own live read fails (GitHub 5xx) while this is set. */
let readFails = false;
const live = (): LivePr => ({
  state: gh.state, merged: gh.merged, headSha: gh.head, headRepoFullName: REPO, baseRef: 'dev', updatedAt: gh.updatedAt,
  mergedAt: gh.merged ? '2026-10-06T00:00:00Z' : null, mergeCommitSha: gh.merged ? `M-${gh.head}` : null,
});
/** GitHub's pull object, as the webhook payload and `githubApi` carry it. */
const pull = () => ({
  state: gh.state, merged: gh.merged, merged_at: gh.merged ? '2026-10-06T00:00:00Z' : null, merge_commit_sha: gh.merged ? `M-${gh.head}` : null,
  updated_at: gh.updatedAt, head: { sha: gh.head, repo: { full_name: REPO } }, base: { ref: 'dev' },
});
const reader: GithubFactReader = {
  readPr: async () => (readFails ? null : live()),
  contains: async (_repo, ancestor, head) => ancestor === head,
  ciGreen: async () => null,
  checkRuns: async () => null,
  branchHead: async () => null,
  failingChecks: async () => null,
  branchExists: async () => null,
  contentEquivalent: async () => false,
};
const repoFor = async () => ({ installationId: 1, repoFullName: REPO, gitConfig: null });

const realGithubFacts = await import('../../src/lib/workflow/github-facts');
mock.module('../../src/lib/workflow/github-facts', () => ({ ...realGithubFacts, githubReader: () => reader, workspaceRepo: repoFor }));
const realGithub = await import('../../src/lib/github');
mock.module('../../src/lib/github', () => ({ ...realGithub, githubApi: async () => pull() }));
// No effect is drained anywhere in this file: a row that moved moved inside a transition statement.
const realClient = await import('../../src/lib/workflow/kernel-client');
mock.module('../../src/lib/workflow/kernel-client', () => ({ ...realClient, hostsKernelHere: async () => false, drainOnControlPlane: async () => null }));
const realEmit = await import('../../src/lib/core-emit');
mock.module('../../src/lib/core-emit', () => ({ ...realEmit, emit: async () => {} }));
/** Redis due-queues, in memory. */
const dueQueues = new Map<string, Map<string, number>>();
const redisKeys = new Map<string, unknown>();
const queue = (job: string) => dueQueues.get(job) ?? dueQueues.set(job, new Map()).get(job)!;
const realRedis = await import('../../src/lib/redis');
mock.module('../../src/lib/redis', () => ({
  ...realRedis,
  markDue: async (job: string, member: string, at: number) => { queue(job).set(member, at); },
  markDueEarliest: async (job: string, member: string, at: number) => { const p = queue(job).get(member); if (p === undefined || at < p) queue(job).set(member, at); },
  getKey: async (k: string) => (redisKeys.has(k) ? redisKeys.get(k) : null),
  setWithTtl: async (k: string, v: unknown) => { redisKeys.set(k, v); return true; },
  delKey: async (k: string) => { redisKeys.delete(k); },
  clearDue: async (job: string, members: string | string[]) => { for (const m of [members].flat()) queue(job).delete(m); },
  countDue: async (job: string, now: number) => [...queue(job).values()].filter((t) => t <= now).length,
  listDue: async (job: string, now: number, limit: number) => [...queue(job).entries()].filter(([, t]) => t <= now).map(([m]) => m).slice(0, limit),
}));

const seam = await import('../../src/lib/workflow/seam');
const { loadView } = await import('../../src/lib/workflow/kernel');
const { refreshWorkerMergeStateIfStale } = await import('../../src/lib/pr-reconcile');
const { runDueKernelHeals, KERNEL_HEAL_QUEUE, KERNEL_HEAL_DELAY_MS } = await import('../../src/lib/workflow/kernel-heal');
const { floorCandidatesSql, floorCheckedSql } = await import('../../src/lib/workflow/reconcile');
const { getDeliveryViewsForTasks } = await import('../../src/lib/workflow/delivery-view');

const prUrl = (n: number) => `https://github.com/${REPO}/pull/${n}`;
const deps = { reader: () => reader, repoFor, drain: async () => null };
type Delivery = { ownerTaskId: string; prNumber: number; deliveryId: string; workerId: string };

beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});
beforeEach(() => { gh = { head: 'H1', state: 'open', merged: false, updatedAt: 'u0' }; readFails = false; dueQueues.clear(); redisKeys.clear(); });

async function open(): Promise<Delivery> {
  const ownerTaskId = await seedTask(workspaceId, { status: 'in_progress', title: 'feat: heal owner' });
  const prNumber = prSeq++;
  const [w] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, pr_number, pr_url, pr_lifecycle_status)
    VALUES (${workspaceId}::uuid, ${ownerTaskId}::uuid, 'w', 'test', 'feat/heal', 'running', 'H1', ${prNumber}, ${prUrl(prNumber)}, 'ci_green') RETURNING id`);
  const opened = await seam.openKernelDelivery({ workspaceId, ownerTaskId, repoFullName: REPO, prNumber, installationId: 1, source: 'webhook:opened' }, deps);
  expect(opened.owned).toBe(true);
  return { ownerTaskId, prNumber, deliveryId: opened.deliveryId!, workerId: w.id };
}
const row = async (id: string) => (await q<{ merged_at: string | null; pr_lifecycle_status: string | null }>(sql`SELECT merged_at, pr_lifecycle_status FROM workers WHERE id = ${id}::uuid`))[0];
const state = async (o: Delivery) => (await loadView({ deliveryId: o.deliveryId })).delivery!.state;
const unappliedFacts = (o: Delivery) => q<{ id: string; source: string }>(sql`SELECT id, source FROM workflow_facts
  WHERE workspace_id = ${workspaceId}::uuid AND repo_full_name = ${REPO} AND pr_number = ${o.prNumber} AND kind = 'pr_closed' AND applied_transition_id IS NULL`);

describe('worst case 1: the merge webhook is lost entirely', () => {
  test('the dependency gate\'s live read applies T17 in the same call; the row carries the merge, so it answers true', async () => {
    const o = await open();
    gh = { ...gh, state: 'closed', merged: true, updatedAt: 'u1' };
    // No webhook, no render, no cron: only the dependency gate asks.
    const ok = await refreshWorkerMergeStateIfStale({ id: o.workerId, prNumber: o.prNumber, prUrl: prUrl(o.prNumber) }, 1, { workspaceId });
    expect(ok).toBe(true);
    expect(await state(o)).toBe('MERGED');
    expect(await row(o.workerId)).toMatchObject({ pr_lifecycle_status: 'merged' });
    expect(new Date((await row(o.workerId)).merged_at!).toISOString()).toBe('2026-10-06T00:00:00.000Z');
  });

  test('from a page render it records the merge and applies nothing, and the next minute\'s tick applies it', async () => {
    const o = await open();
    gh = { ...gh, state: 'closed', merged: true, updatedAt: 'u2' };
    const ok = await refreshWorkerMergeStateIfStale({ id: o.workerId, prNumber: o.prNumber, prUrl: prUrl(o.prNumber) }, 1, { workspaceId, observeOnly: true });
    expect(ok).toBe(false);
    expect(await state(o)).not.toBe('MERGED');
    expect((await row(o.workerId)).merged_at).toBeNull();
    expect(queue(KERNEL_HEAL_QUEUE).has(o.deliveryId)).toBe(true);

    const r = await runDueKernelHeals({ now: () => Date.now() + KERNEL_HEAL_DELAY_MS + 1_000 });
    expect(r?.due).toBeGreaterThanOrEqual(1);
    expect(await state(o)).toBe('MERGED');
    expect(await row(o.workerId)).toMatchObject({ pr_lifecycle_status: 'merged' });
    expect(queue(KERNEL_HEAL_QUEUE).has(o.deliveryId)).toBe(false);
  });
});

describe('worst case 2: the webhook arrives, the kernel\'s own live read fails', () => {
  test('observePrState reports the failure, keeps the payload as an unapplied fact and queues the fast heal; the tick heals it', async () => {
    const o = await open();
    gh = { ...gh, state: 'closed', merged: true, updatedAt: 'u3' };
    readFails = true;
    await expect(seam.observePrState({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, source: 'webhook:closed', pull: pull() }, deps))
      .rejects.toMatchObject({ name: 'KernelObservationFailed', deliveryId: o.deliveryId });
    expect(await unappliedFacts(o)).toEqual([expect.objectContaining({ source: 'webhook:closed' })]);
    expect((await row(o.workerId)).merged_at).toBeNull();
    expect(queue(KERNEL_HEAL_QUEUE).get(o.deliveryId)).toBeGreaterThan(Date.now());

    // The floor would take it first too, quiet window or not.
    const [first] = await q<{ id: string }>(floorCandidatesSql({ limit: 1, minQuietMs: 10 * 60_000, only: [o.deliveryId] }));
    expect(first?.id).toBe(o.deliveryId);

    // GitHub answers again; a minute later the tick applies T17.
    readFails = false;
    await runDueKernelHeals({ now: () => Date.now() + KERNEL_HEAL_DELAY_MS + 1_000 });
    expect(await state(o)).toBe('MERGED');
    expect(await row(o.workerId)).toMatchObject({ pr_lifecycle_status: 'merged' });
    expect(await unappliedFacts(o)).toEqual([]);
  });

  test('a read that keeps failing is looked at again later, not dropped', async () => {
    const o = await open();
    gh = { ...gh, state: 'closed', merged: true, updatedAt: 'u4' };
    readFails = true;
    await seam.observePrState({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, source: 'webhook:closed', pull: pull() }, deps).catch(() => null);
    const now = Date.now() + KERNEL_HEAL_DELAY_MS + 1_000;
    const r = await runDueKernelHeals({ now: () => now });
    expect(r?.rescheduled).toBeGreaterThanOrEqual(1);
    expect(queue(KERNEL_HEAL_QUEUE).get(o.deliveryId)).toBeGreaterThan(now);
  });
});

describe('the floor does not starve', () => {
  test('checked deliveries rotate behind unchecked ones, and a delivery released to legacy takes no slot', async () => {
    const a = await open();
    const b = await open();
    const c = await open();
    const only = [a.deliveryId, b.deliveryId, c.deliveryId];
    await q(sql`UPDATE workflow_deliveries SET last_transition_at = now() - interval '2 hours' WHERE id IN (${sql.raw(only.map((x) => `'${x}'::uuid`).join(', '))})`);
    await q(floorCheckedSql([a.deliveryId]));
    await q(sql`UPDATE workflow_deliveries SET authority = 'legacy' WHERE id = ${c.deliveryId}::uuid`);
    const ids = (await q<{ id: string }>(floorCandidatesSql({ limit: 10, minQuietMs: 0, only }))).map((r) => r.id);
    expect(ids).toEqual([b.deliveryId, a.deliveryId]);
  });
});

describe('AC-4: a merge after ABANDONED is recorded loudly, never applied', () => {
  test('no worker column changes; the fact carries the contradiction, a notice is queued, and the view says so', async () => {
    const o = await open();
    gh = { ...gh, state: 'closed', merged: false, updatedAt: 'u5' };
    expect(await seam.abandonDelivery({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, actor: 'human:owner', reason: 'the work is dropped' }, deps))
      .toMatchObject({ handled: true });
    expect(await state(o)).toBe('ABANDONED');
    const before = await row(o.workerId);

    gh = { ...gh, state: 'closed', merged: true, updatedAt: 'u6' };
    await seam.observePrState({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, source: 'webhook:closed', pull: pull() }, deps);
    // Twice: the record is idempotent.
    await seam.observePrState({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, source: 'sweep:pr-reconcile', pull: pull() }, deps);

    expect(await state(o)).toBe('ABANDONED');
    expect(await row(o.workerId)).toEqual(before);
    const facts = await q<{ payload: { contradiction?: { reason: string; deliveryState: string } } }>(sql`SELECT payload FROM workflow_facts
      WHERE workspace_id = ${workspaceId}::uuid AND repo_full_name = ${REPO} AND pr_number = ${o.prNumber} AND payload ? 'contradiction'`);
    expect(facts.map((f) => f.payload.contradiction)).toEqual([expect.objectContaining({ reason: 'merged_after_abandoned', deliveryState: 'ABANDONED' })]);
    const notices = await q<{ status: string; payload: { event: string } }>(sql`SELECT status, payload FROM workflow_effects
      WHERE delivery_id = ${o.deliveryId}::uuid AND kind = 'notify' AND dedupe_key = ${`notify:${o.deliveryId}:merged_after_resolution`}`);
    expect(notices).toHaveLength(1);
    expect(notices[0].payload.event).toBe('merged_after_resolution');
    const view = (await getDeliveryViewsForTasks([o.ownerTaskId])).get(o.ownerTaskId);
    expect(view?.detail).toContain('after buildd recorded it as abandoned');
  });
});
