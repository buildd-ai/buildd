/**
 * Held release tasks (workflow-kernel-library.md §4, review of #4786): a release that could
 * not land when its task finished is settled by its PR, on real Postgres. Merged: the task
 * completes. Closed unmerged: it fails with the reason. Nothing arriving: the hourly sweep
 * reads the PR, retries a green one through the release-on-green door, and fails a task held
 * past its bound, so no release stays pending forever. Each settles once.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const notified: string[] = [];
const outcomes: Array<{ taskId: string; failure: unknown }> = [];
const realNotify = await import('../../src/lib/notify');
mock.module('../../src/lib/notify', () => ({ ...realNotify, notifyTeamOf: async (_s: unknown, _e: unknown, p: { title: string }) => { notified.push(p.title); } }));
const realOutcome = await import('../../src/lib/task-outcome-event');
mock.module('../../src/lib/task-outcome-event', () => ({ ...realOutcome, emitHeldReleaseOutcome: async (taskId: string, failure: unknown) => { outcomes.push({ taskId, failure }); } }));

const { settleHeldReleaseTask, settleHeldReleasesOnClose, sweepHeldReleases } = await import('../../src/lib/held-pr-tasks');

beforeAll(() => { assertDbConfigured(); });

const REPO = `acme/held-${Date.now().toString(36)}`;
let workspaceId: string;
let prSeq = 100;
const repoFor = async () => ({ installationId: 1, repoFullName: REPO, gitConfig: null }) as never;

async function held(o: { sweeps?: number; method?: string } = {}): Promise<{ taskId: string; prNumber: number }> {
  const prNumber = prSeq++;
  const taskId = await seedTask(workspaceId, { status: 'completed' });
  const ctx = { releasePrPending: true, releasePrNumber: prNumber, releasePrUrl: `https://github.com/${REPO}/pull/${prNumber}`, ...(o.sweeps ? { releaseHoldSweeps: o.sweeps } : {}), ...(o.method ? { releaseMergeMethod: o.method } : {}) };
  await q(sql`UPDATE tasks SET context = ${JSON.stringify(ctx)}::jsonb WHERE id = ${taskId}::uuid`);
  return { taskId, prNumber };
}
const row = async (taskId: string) => (await q<{ status: string; context: Record<string, unknown>; release_result: Record<string, unknown> | null }>(
  sql`SELECT status, context, release_result FROM tasks WHERE id = ${taskId}::uuid`))[0]!;

describe('held releases', () => {
  beforeAll(async () => {
    ({ workspaceId } = await seedWorkspace());
  });

  test('the PR merging (by any door, or a person) completes the held task, once', async () => {
    const h = await held();
    expect(await settleHeldReleasesOnClose({ repoFullName: REPO, prNumber: h.prNumber, merged: true }, repoFor)).toBe(1);
    const r = await row(h.taskId);
    expect({ status: r.status, pending: r.context.releasePrPending, rs: r.release_result?.status }).toEqual({ status: 'completed', pending: false, rs: 'completed' });
    expect(await settleHeldReleasesOnClose({ repoFullName: REPO, prNumber: h.prNumber, merged: true }, repoFor)).toBe(0);
    expect(outcomes.filter((x) => x.taskId === h.taskId)).toEqual([{ taskId: h.taskId, failure: null }]);
  });

  test('the PR closing unmerged fails the held task with the reason, and a person is told', async () => {
    const h = await held();
    expect(await settleHeldReleasesOnClose({ repoFullName: REPO, prNumber: h.prNumber, merged: false }, repoFor)).toBe(1);
    const r = await row(h.taskId);
    expect(r.status).toBe('failed');
    expect(String(r.release_result?.error)).toContain('closed without merging');
    expect(notified.some((t) => t.startsWith('Release PR closed'))).toBe(true);
  });

  test('two settles racing on the same held task (the webhook and the sweep): only the first acts', async () => {
    const h = await held();
    const t = { id: h.taskId, workspaceId, context: { releasePrPending: true, releasePrNumber: h.prNumber } };
    expect(await settleHeldReleaseTask(t, { merged: true, prNumber: h.prNumber, repoFullName: REPO, via: 'the PR merged' })).toBe(true);
    expect(await settleHeldReleaseTask(t, { merged: false, prNumber: h.prNumber, repoFullName: REPO, reason: 'late close', title: 'Release PR closed' })).toBe(false);
    expect((await row(h.taskId)).status).toBe('completed');
    expect(outcomes.filter((x) => x.taskId === h.taskId)).toHaveLength(1);
  });

  test('a PR in another repo with the same number settles nothing', async () => {
    const h = await held();
    expect(await settleHeldReleasesOnClose({ repoFullName: 'acme/other', prNumber: h.prNumber, merged: true }, repoFor)).toBe(0);
    expect((await row(h.taskId)).context.releasePrPending).toBe(true);
    await q(sql`UPDATE tasks SET context = context - 'releasePrPending' WHERE id = ${h.taskId}::uuid`);
  });

  test('the sweep: a merged PR completes, a closed one fails, a green open one is retried, a waiting one counts its sweeps, one held past the bound fails', async () => {
    const merged = await held();
    const closed = await held();
    const green = await held({ method: 'squash' });
    const waiting = await held();
    const stale = await held({ sweeps: 3 });
    const prs: Record<number, Record<string, unknown>> = {
      [merged.prNumber]: { state: 'closed', merged: true },
      [closed.prNumber]: { state: 'closed', merged: false },
      [green.prNumber]: { state: 'open', merged: false, head: { sha: 'G1' } },
      [waiting.prNumber]: { state: 'open', merged: false, head: { sha: 'W1' } },
      [stale.prNumber]: { state: 'open', merged: false, head: { sha: 'S1' } },
    };
    const retried: Array<[number, string]> = [];
    const res = await sweepHeldReleases({ maxSweeps: 3, workspaceId }, {
      repoFor,
      api: async (_i, path) => prs[Number(/pulls\/(\d+)$/.exec(path)![1])] ?? null,
      ciGreen: async (_i, _r, sha) => sha === 'G1',
      retry: async (prNumber, _i, _r, sha) => { retried.push([prNumber, sha]); },
    });
    expect(res).toMatchObject({ completed: 1, failed: 2, retried: 1, waiting: 1, errors: 0 });
    expect((await row(merged.taskId)).status).toBe('completed');
    expect((await row(closed.taskId)).status).toBe('failed');
    expect(retried).toEqual([[green.prNumber, 'G1']]);
    expect((await row(waiting.taskId)).context).toMatchObject({ releasePrPending: true, releaseHoldSweeps: 1 });
    const s = await row(stale.taskId);
    expect(s.status).toBe('failed');
    expect(String(s.release_result?.error)).toContain('after 3 hourly retries');
  });
});
