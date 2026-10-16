/**
 * S4a (docs/specs/workflow-kernel-library.md §1, AC-1 / AC-2 / AC-4) on real Postgres: for a
 * delivery-owned task, `workers.merged_at` and `workers.pr_lifecycle_status` change in the
 * kernel transition that changes the delivery, in the same statement, and the fact funnel
 * outside the kernel records only what the delivery already says.
 *
 * Every case runs with NO effect drained (the request's inline drain never runs), so a worker
 * row that moved can only have moved inside the transition statement itself, never through the
 * `stamp_pr_rows` effect that used to carry it.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import type { LivePr } from '../../src/lib/workflow/commands';
import type { GithubFactReader } from '../../src/lib/workflow/facts';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const REPO = 'acme/projection';
let workspaceId: string;
/** Random base: PR numbers repeat across runs against one database (a second run must not see the first's rows). */
let prSeq = 100_000 + Math.floor(Math.random() * 800_000);

interface FakePr { head: string; state: 'open' | 'closed'; merged: boolean; updatedAt: string }
let gh: FakePr;
const live = (): LivePr => ({
  state: gh.state, merged: gh.merged, headSha: gh.head, headRepoFullName: REPO, baseRef: 'dev', updatedAt: gh.updatedAt,
  mergedAt: gh.merged ? '2026-10-06T00:00:00Z' : null, mergeCommitSha: gh.merged ? `M-${gh.head}` : null,
});
const reader: GithubFactReader = {
  readPr: async () => live(),
  contains: async (_repo, ancestor, head) => ancestor === head,
  ciGreen: async () => null,
  checkRuns: async () => null,
  branchHead: async () => null,
  failingChecks: async () => null,
  branchExists: async () => null,
  contentEquivalent: async () => false,
};
const repoFor = async () => ({ installationId: 1, repoFullName: REPO, gitConfig: null });
/** The request died after its transition committed: no effect ever ran. */
const deps = { reader: () => reader, repoFor, drain: async () => null };

const seam = await import('../../src/lib/workflow/seam');
const { recordPrFact } = await import('@buildd/core/pr-facts');
const { factFunnelScope } = await import('../../src/lib/workflow/pr-fact-scope');
const { loadView } = await import('../../src/lib/workflow/kernel');

const prUrl = (n: number) => `https://github.com/${REPO}/pull/${n}`;
type Delivery = { ownerTaskId: string; prNumber: number; deliveryId: string; ownerWorkerId: string; retryWorkerId: string };

beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});
beforeEach(() => { gh = { head: 'H1', state: 'open', merged: false, updatedAt: 'u0' }; });

async function seedWorker(taskId: string, prNumber: number, status: string) {
  const [w] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, pr_number, pr_url, pr_lifecycle_status)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, 'w', 'test', 'feat/projection', ${status}, 'H1', ${prNumber}, ${prUrl(prNumber)}, 'ci_green') RETURNING id`);
  return w.id;
}

/** A kernel-owned PR: the owner's worker row, plus a CI-retry attempt's row that adopted the PR. */
async function open(): Promise<Delivery> {
  const ownerTaskId = await seedTask(workspaceId, { status: 'in_progress', title: 'feat: projection owner' });
  const prNumber = prSeq++;
  const ownerWorkerId = await seedWorker(ownerTaskId, prNumber, 'running');
  const retryTaskId = await seedTask(workspaceId, { status: 'completed', title: 'fix: ci retry' });
  const retryWorkerId = await seedWorker(retryTaskId, prNumber, 'completed');
  const opened = await seam.openKernelDelivery({ workspaceId, ownerTaskId, repoFullName: REPO, prNumber, installationId: 1, source: 'webhook:opened' }, deps);
  expect(opened.owned).toBe(true);
  return { ownerTaskId, prNumber, deliveryId: opened.deliveryId!, ownerWorkerId, retryWorkerId };
}

const rows = (o: Delivery) => q<{ id: string; pr_lifecycle_status: string | null; merged_at: string | null }>(
  sql`SELECT id, pr_lifecycle_status, merged_at FROM workers WHERE pr_number = ${o.prNumber}::int AND workspace_id = ${workspaceId}::uuid ORDER BY created_at, id`);
const transitionsTo = (o: Delivery, state: string) => q<{ id: string; to_version: number }>(
  sql`SELECT id, to_version FROM workflow_transitions WHERE delivery_id = ${o.deliveryId}::uuid AND to_state = ${state}`);
const pendingStamps = (o: Delivery) => q<{ status: string }>(
  sql`SELECT status FROM workflow_effects WHERE delivery_id = ${o.deliveryId}::uuid AND kind = 'stamp_pr_rows'`);
/** The webhook's `pull_request.closed` call for a kernel-owned PR. */
const webhookClosed = () => seam.observePrState({ workspaceId, repoFullName: REPO, prNumber: 0, installationId: 1, source: 'webhook:closed' }, deps);

describe('AC-2: a merged webhook moves the delivery and every worker row of the PR in one transition', () => {
  test('T17 stamps merged_at (GitHub\'s instant) and merged on both rows; the effect that used to do it has not run', async () => {
    const o = await open();
    gh = { ...gh, state: 'closed', merged: true, updatedAt: 'u1' };
    expect(await seam.observePrState({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, source: 'webhook:closed' }, deps)).toBe(true);

    expect((await loadView({ deliveryId: o.deliveryId })).delivery).toMatchObject({ state: 'MERGED' });
    expect((await transitionsTo(o, 'MERGED')).length).toBe(1);
    // The effect is still queued: it never ran, so the rows moved inside the transition's statement.
    expect((await pendingStamps(o)).map((e) => e.status)).toEqual(['pending']);
    const after = await rows(o);
    expect(after.map((r) => r.pr_lifecycle_status)).toEqual(['merged', 'merged']);
    for (const r of after) expect(new Date(r.merged_at!).toISOString()).toBe('2026-10-06T00:00:00.000Z');
  });

  test('T18 projects the close the same way, and the funnel\'s later merge receipt cannot overwrite the kernel', async () => {
    const o = await open();
    gh = { ...gh, state: 'closed', merged: false, updatedAt: 'u2' };
    await seam.observePrState({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, source: 'webhook:closed' }, deps);
    expect((await loadView({ deliveryId: o.deliveryId })).delivery).toMatchObject({ state: 'CLOSED_UNMERGED' });
    expect((await rows(o)).map((r) => r.pr_lifecycle_status)).toEqual(['closed', 'closed']);

    // A merge door's receipt for the same PR: the delivery is closed, so the funnel writes nothing.
    expect(await recordPrFact({ prUrl: prUrl(o.prNumber), prNumber: o.prNumber }, { kind: 'merged', mergedAt: new Date() }, { scope: factFunnelScope })).toEqual([]);
    expect((await rows(o)).map((r) => [r.pr_lifecycle_status, r.merged_at])).toEqual([['closed', null], ['closed', null]]);
  });

  test.todo('S4b: the same transition completes the owner task (tasks.status), not runMergedPrWork after it');
});

describe('AC-1 / AC-4: outside the kernel the funnel records only what the delivery says', () => {
  test('a merge fact for a delivery the kernel has not merged writes no worker column', async () => {
    const o = await open();
    const before = await rows(o);
    expect(await recordPrFact({ prUrl: prUrl(o.prNumber), prNumber: o.prNumber }, { kind: 'merged', mergedAt: new Date() }, { scope: factFunnelScope })).toEqual([]);
    expect(await recordPrFact({ workerId: o.ownerWorkerId }, { kind: 'closed' }, { scope: factFunnelScope })).toEqual([]);
    expect(await rows(o)).toEqual(before);
  });

  test('AC-4: a merged fact for an ABANDONED delivery changes no column', async () => {
    const o = await open();
    // T21 needs the PR closed; the door catches the close up from GitHub (T18), then abandons.
    gh = { ...gh, state: 'closed', merged: false, updatedAt: 'u3' };
    expect(await seam.abandonDelivery({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, actor: 'human:owner', reason: 'the work is dropped' }, deps)).toMatchObject({ handled: true });
    expect((await loadView({ deliveryId: o.deliveryId })).delivery).toMatchObject({ state: 'ABANDONED' });
    const before = await rows(o);

    gh = { ...gh, state: 'closed', merged: true, updatedAt: 'u4' };
    await seam.observePrState({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, source: 'webhook:closed' }, deps);
    expect(await recordPrFact({ prUrl: prUrl(o.prNumber), prNumber: o.prNumber }, { kind: 'merged', mergedAt: new Date() }, { scope: factFunnelScope })).toEqual([]);
    expect((await loadView({ deliveryId: o.deliveryId })).delivery).toMatchObject({ state: 'ABANDONED' });
    expect(await rows(o)).toEqual(before);
  });

  test('a sweep healing a row the merge missed agrees with a MERGED delivery, and keeps the first instant', async () => {
    const o = await open();
    gh = { ...gh, state: 'closed', merged: true, updatedAt: 'u5' };
    await seam.observePrState({ workspaceId, repoFullName: REPO, prNumber: o.prNumber, installationId: 1, source: 'webhook:closed' }, deps);
    // A row that adopted the PR after the merge (a late retry), so the transition never saw it.
    const lateTask = await seedTask(workspaceId, { status: 'completed', title: 'fix: late retry' });
    const late = await seedWorker(lateTask, o.prNumber, 'completed');
    const healed = await recordPrFact({ prUrl: prUrl(o.prNumber), prNumber: o.prNumber }, { kind: 'merged', mergedAt: '2026-10-06T00:00:00Z' }, { scope: factFunnelScope });
    expect(healed.map((r) => r.id)).toEqual([late]);
    expect((await rows(o)).map((r) => r.pr_lifecycle_status)).toEqual(['merged', 'merged', 'merged']);
  });

  test('the kill switch off: legacy decides, and the funnel writes as it always has', async () => {
    const o = await open();
    await q(sql`UPDATE workspaces SET git_config = jsonb_build_object('workflowKernel', false) WHERE id = ${workspaceId}::uuid`);
    try {
      const stamped = await recordPrFact({ prUrl: prUrl(o.prNumber), prNumber: o.prNumber }, { kind: 'merged', mergedAt: '2026-10-07T00:00:00Z' }, { scope: factFunnelScope });
      expect(stamped.length).toBe(2);
    } finally {
      await q(sql`UPDATE workspaces SET git_config = NULL WHERE id = ${workspaceId}::uuid`);
    }
  });

  test('a PR with no delivery keeps today\'s writer', async () => {
    const taskId = await seedTask(workspaceId, { status: 'in_progress', title: 'feat: legacy' });
    const n = prSeq++;
    const w = await seedWorker(taskId, n, 'completed');
    expect((await recordPrFact({ prUrl: prUrl(n), prNumber: n }, { kind: 'merged', mergedAt: '2026-10-07T00:00:00Z' }, { scope: factFunnelScope })).map((r) => r.id)).toEqual([w]);
  });

  test('webhookClosed for an unknown PR is not kernel-owned', async () => {
    expect(await webhookClosed()).toBe(false);
  });
});
