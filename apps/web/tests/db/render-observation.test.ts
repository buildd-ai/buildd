/**
 * AC-3 against real Postgres (docs/specs/workflow-kernel-library.md §1): what a
 * page render may do with a delivery-owned PR, and how the healers pick up
 * what it recorded.
 *
 *  - A render records the `pr_closed` fact unapplied; the webhook's ingest of
 *    the same key applies it, and the stored fact then carries the applying
 *    read (its payload and source), not the render's.
 *  - Delivery ownership by PR matches the repo as well as the number, so a
 *    task in another repo with the same PR number keeps healing.
 *  - Ownership is the one definition the fact funnel uses (S4a,
 *    pr-fact-scope.ts `kernelOwnedRowSql`): kernel authority, switch on. A
 *    delivery released to legacy is not owned, so a read heals it as before.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { ingestFact, type GithubFactReader } from '../../src/lib/workflow/facts';
import { deliveryOwnedWorkers, recordPrStateObserved } from '../../src/lib/workflow/render-observation';
import type { LivePr } from '../../src/lib/workflow/commands';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

let workspaceId: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});

const REPO = 'acme/widgets';
const OTHER_REPO = 'acme/gadgets';
let prSeq = 4100;
const live = (extra: Partial<LivePr> = {}): LivePr => ({
  state: 'open', merged: false, headSha: 'h0', headRepoFullName: REPO, baseRef: 'feature/base', ...extra,
});
const reader = (pr: () => LivePr, more: Partial<GithubFactReader> = {}): GithubFactReader => ({ readPr: async () => pr(), ...more });
const prUrl = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;

async function openDelivery(): Promise<{ taskId: string; deliveryId: string; prNumber: number }> {
  const taskId = await seedTask(workspaceId, { status: 'in_progress' });
  const prNumber = prSeq++;
  const opened = await ingestFact({ kind: 'delivery_opened', workspaceId, source: 'runner', ownerTaskId: taskId, requiresPr: true });
  expect(opened.result).toBe('applied');
  const bound = await ingestFact(
    { kind: 'pr_bound', workspaceId, source: 'runner', repoFullName: REPO, prNumber, ownerTaskId: taskId },
    { github: reader(() => live()) },
  );
  expect(bound.result).toBe('applied');
  return { taskId, deliveryId: (opened as { deliveryId: string }).deliveryId, prNumber };
}

async function seedWorker(taskId: string, url: string, prNumber: number): Promise<string> {
  const [w] = await q<{ id: string }>(sql`
    INSERT INTO workers (workspace_id, task_id, name, runner, branch, pr_url, pr_number)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, 'w', 'test', 'b', ${url}, ${prNumber}) RETURNING id`);
  return w.id;
}

describe('a render-recorded fact is applied by the healer with the healer\'s read', () => {
  test('render records unapplied; the webhook ingest of the same key applies it and its payload replaces the render\'s', async () => {
    const { deliveryId, prNumber } = await openDelivery();
    const closedAt = '2026-01-02T00:00:00Z';
    const closed = live({ state: 'closed', updatedAt: closedAt });
    // The render's read: GitHub's pull object, no base-branch probe.
    const pull = { state: 'closed', merged: false, merged_at: null, updated_at: closedAt, head: { sha: 'h0', repo: { full_name: REPO } }, base: { ref: 'feature/base' } };
    expect(await recordPrStateObserved({ workspaceId, repoFullName: REPO, prNumber, pull, source: 'render:test' })).toBe(true);

    const key = `closed:${REPO}#${prNumber}:${closedAt}`;
    const before = await q<{ applied_transition_id: string | null; source: string; payload: Record<string, unknown> }>(
      sql`SELECT applied_transition_id, source, payload FROM workflow_facts WHERE workspace_id = ${workspaceId}::uuid AND fact_key = ${key}`);
    expect(before).toHaveLength(1);
    expect(before[0].applied_transition_id).toBeNull();
    expect(before[0].source).toBe('render:test');
    expect(before[0].payload).not.toHaveProperty('baseExists');

    const r = await ingestFact(
      { kind: 'pr_closed', workspaceId, source: 'webhook:closed', repoFullName: REPO, prNumber },
      { github: reader(() => closed, { branchExists: async () => false }) },
    );
    expect(r).toMatchObject({ result: 'applied', firstSeen: false });

    const after = await q<{ applied_transition_id: string | null; source: string; payload: Record<string, unknown> }>(
      sql`SELECT applied_transition_id, source, payload FROM workflow_facts WHERE workspace_id = ${workspaceId}::uuid AND fact_key = ${key}`);
    expect(after).toHaveLength(1);
    expect(after[0].applied_transition_id).not.toBeNull();
    expect(after[0].source).toBe('webhook:closed');
    expect(after[0].payload).toMatchObject({ baseExists: false });

    const [d] = await q<{ state: string; state_reason: string | null }>(sql`SELECT state, state_reason FROM workflow_deliveries WHERE id = ${deliveryId}::uuid`);
    expect(d.state_reason).toBe('base_deleted');
  });
});

describe('delivery ownership by PR matches the repo', () => {
  test('same PR number in another repo, no delivery: not owned; same repo: owned', async () => {
    const { prNumber } = await openDelivery();
    const otherTask = await seedTask(workspaceId, { status: 'completed' });
    const otherRepoWorker = await seedWorker(otherTask, prUrl(OTHER_REPO, prNumber), prNumber);
    const sameRepoTask = await seedTask(workspaceId, { status: 'completed' });
    const sameRepoWorker = await seedWorker(sameRepoTask, prUrl(REPO, prNumber).toUpperCase().replace('HTTPS://GITHUB.COM', 'https://github.com'), prNumber);

    const owned = await deliveryOwnedWorkers([otherRepoWorker, sameRepoWorker]);
    expect(owned.has(otherRepoWorker)).toBe(false);
    expect(owned.has(sameRepoWorker)).toBe(true);
  });

  test('ownership is by PR: a worker of the owner task on another PR heals that PR as before', async () => {
    const { taskId, prNumber } = await openDelivery();
    const w = await seedWorker(taskId, prUrl(OTHER_REPO, prNumber + 9000), prNumber + 9000);
    expect((await deliveryOwnedWorkers([w])).has(w)).toBe(false);
  });

  test('a delivery released to legacy is not delivery-owned (S4a: one definition with the funnel)', async () => {
    const { taskId, deliveryId, prNumber } = await openDelivery();
    const w = await seedWorker(taskId, prUrl(REPO, prNumber), prNumber);
    expect((await deliveryOwnedWorkers([w])).has(w)).toBe(true);
    await q(sql`UPDATE workflow_deliveries SET authority = 'legacy' WHERE id = ${deliveryId}::uuid`);
    expect((await deliveryOwnedWorkers([w])).has(w)).toBe(false);
  });
});
