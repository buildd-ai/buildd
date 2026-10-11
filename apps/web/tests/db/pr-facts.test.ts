/**
 * The PR fact funnel on real Postgres (docs/specs/workflow-state-kernel.md
 * §12, §16 S6, AC-8): every ordering rule lives in recordPrFact's WHERE, so a
 * mocked db could never show it. Each case writes facts in a hostile order and
 * reads the row back.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { recordPrFact, prFactApplies, type PrFact } from '@buildd/core/pr-facts';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

let workspaceId: string;
let prSeq = 7300;

beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});

async function prRows(n = 1, status: string | null = 'pr_open') {
  const prNumber = prSeq++;
  const prUrl = `https://github.com/acme/facts/pull/${prNumber}`;
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const taskId = await seedTask(workspaceId, { status: 'completed' });
    const [w] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, pr_url, pr_number, pr_lifecycle_status)
      VALUES (${workspaceId}::uuid, ${taskId}::uuid, 'w', 'test', 'feat/facts', 'completed', ${prUrl}, ${prNumber}, ${status}) RETURNING id`);
    ids.push(w.id);
  }
  return { prNumber, prUrl, ids };
}

const row = async (id: string) => (await q<{ pr_lifecycle_status: string | null; merged_at: string | null; conflict_detected_at: string | null; pr_last_checked_at: string | null }>(
  sql`SELECT pr_lifecycle_status, merged_at, conflict_detected_at, pr_last_checked_at FROM workers WHERE id = ${id}::uuid`))[0];

describe('recordPrFact — terminal wins (S6, AC-8)', () => {
  test('a merge stamps every row of the PR with GitHub\'s merged_at, once', async () => {
    const pr = await prRows(2);
    const first = await recordPrFact({ prUrl: pr.prUrl, prNumber: pr.prNumber }, { kind: 'merged', mergedAt: '2026-10-01T10:00:00Z' });
    expect(first.map((r) => r.previousStatus)).toEqual(['pr_open', 'pr_open']);
    // A replay (redelivered webhook, a sweep, a merge door's own instant) moves nothing.
    expect(await recordPrFact({ prUrl: pr.prUrl, prNumber: pr.prNumber }, { kind: 'merged', mergedAt: '2026-10-02T00:00:00Z' })).toEqual([]);
    for (const id of pr.ids) {
      const r = await row(id);
      expect(r.pr_lifecycle_status).toBe('merged');
      expect(new Date(r.merged_at!).toISOString()).toBe('2026-10-01T10:00:00.000Z');
    }
  });

  test('after the merge, a late synchronize / opened / check_suite / close / conflict changes nothing', async () => {
    const pr = await prRows();
    await recordPrFact({ workerId: pr.ids[0] }, { kind: 'merged', mergedAt: '2026-10-01T10:00:00Z' });
    const late: PrFact[] = [
      { kind: 'open' }, { kind: 'open', reopened: true },
      { kind: 'ci', status: 'ci_failed' }, { kind: 'ci', status: 'ci_running' }, { kind: 'ci', status: 'ci_green' },
      { kind: 'closed' }, { kind: 'conflict' }, { kind: 'unresolvable', reason: 'late' },
    ];
    for (const f of late) expect(await recordPrFact({ workerId: pr.ids[0] }, f)).toEqual([]);
    const r = await row(pr.ids[0]);
    expect(r).toMatchObject({ pr_lifecycle_status: 'merged', conflict_detected_at: null });
    expect(new Date(r.merged_at!).toISOString()).toBe('2026-10-01T10:00:00.000Z');
  });

  test('a row stamped merged_at by an older writer but not merged status is completed, keeping its instant', async () => {
    const pr = await prRows(1, 'ci_green');
    await q(sql`UPDATE workers SET merged_at = '2026-09-30T00:00:00Z' WHERE id = ${pr.ids[0]}::uuid`);
    expect((await recordPrFact({ workerId: pr.ids[0] }, { kind: 'merged', mergedAt: '2026-10-05T00:00:00Z' })).length).toBe(1);
    const r = await row(pr.ids[0]);
    expect(r.pr_lifecycle_status).toBe('merged');
    expect(new Date(r.merged_at!).toISOString()).toBe('2026-09-30T00:00:00.000Z');
  });

  test('closed yields only to merged or an explicit reopen', async () => {
    const pr = await prRows();
    await recordPrFact({ workerId: pr.ids[0] }, { kind: 'closed' });
    expect(await recordPrFact({ workerId: pr.ids[0] }, { kind: 'open' })).toEqual([]);
    expect(await recordPrFact({ workerId: pr.ids[0] }, { kind: 'ci', status: 'ci_failed' })).toEqual([]);
    expect(await recordPrFact({ workerId: pr.ids[0] }, { kind: 'conflict' })).toEqual([]);
    expect((await row(pr.ids[0])).pr_lifecycle_status).toBe('closed');
    expect((await recordPrFact({ workerId: pr.ids[0] }, { kind: 'open', reopened: true })).length).toBe(1);
    expect((await row(pr.ids[0])).pr_lifecycle_status).toBe('pr_open');
    await recordPrFact({ workerId: pr.ids[0] }, { kind: 'closed' });
    expect((await recordPrFact({ workerId: pr.ids[0] }, { kind: 'merged', mergedAt: '2026-10-03T00:00:00Z' })).length).toBe(1);
    expect((await row(pr.ids[0])).pr_lifecycle_status).toBe('merged');
  });

  test('a CI fact for an old SHA is dropped; one for the current head applies once', async () => {
    const pr = await prRows();
    expect(await recordPrFact({ workerId: pr.ids[0] }, { kind: 'ci', status: 'ci_failed', headSha: 'OLD', currentHeadSha: 'NEW' })).toEqual([]);
    expect((await row(pr.ids[0])).pr_lifecycle_status).toBe('pr_open');
    expect((await recordPrFact({ workerId: pr.ids[0] }, { kind: 'ci', status: 'ci_green', headSha: 'NEW', currentHeadSha: 'NEW' })).length).toBe(1);
    // The same status again is not a change (no churn, no second policy report).
    expect(await recordPrFact({ workerId: pr.ids[0] }, { kind: 'ci', status: 'ci_green', headSha: 'NEW', currentHeadSha: 'NEW' })).toEqual([]);
    expect((await row(pr.ids[0])).pr_lifecycle_status).toBe('ci_green');
  });

  test('conflict_detected_at is first-seen and never moves', async () => {
    const pr = await prRows();
    await recordPrFact({ workerId: pr.ids[0] }, { kind: 'conflict' });
    const first = (await row(pr.ids[0])).conflict_detected_at;
    expect(first).not.toBeNull();
    await recordPrFact({ workerId: pr.ids[0] }, { kind: 'open' });
    await recordPrFact({ workerId: pr.ids[0] }, { kind: 'conflict' });
    expect((await row(pr.ids[0])).conflict_detected_at).toBe(first);
  });

  test('bookkeeping rides along only with an applied fact; an unscoped target writes nothing', async () => {
    const pr = await prRows();
    const at = new Date('2026-10-04T00:00:00Z');
    await recordPrFact({ workerId: pr.ids[0] }, { kind: 'closed' }, { bookkeeping: { prLastCheckedAt: at } });
    expect(new Date((await row(pr.ids[0])).pr_last_checked_at!).toISOString()).toBe(at.toISOString());
    expect(await recordPrFact({ workerIds: [] }, { kind: 'closed' })).toEqual([]);
    expect(await recordPrFact({ prUrl: '', prNumber: 1 }, { kind: 'closed' })).toEqual([]);
  });

  test('the pure mirror agrees with the statement on every (status, fact) pair', async () => {
    const statuses = [null, 'pr_open', 'ci_running', 'ci_green', 'ci_failed', 'conflict', 'closed', 'unresolvable', 'merged'];
    const factsToTry: PrFact[] = [
      { kind: 'merged', mergedAt: '2026-10-01T00:00:00Z' }, { kind: 'closed' }, { kind: 'open' }, { kind: 'open', reopened: true },
      { kind: 'ci', status: 'ci_failed' }, { kind: 'ci', status: 'ci_green' }, { kind: 'conflict' }, { kind: 'unresolvable', reason: 'x' },
    ];
    for (const status of statuses) {
      for (const f of factsToTry) {
        const pr = await prRows(1, status);
        if (status === 'merged') await q(sql`UPDATE workers SET merged_at = now() WHERE id = ${pr.ids[0]}::uuid`);
        const r0 = await row(pr.ids[0]);
        const expected = prFactApplies(f, { prLifecycleStatus: r0.pr_lifecycle_status, mergedAt: r0.merged_at });
        const applied = (await recordPrFact({ workerId: pr.ids[0] }, f)).length === 1;
        expect({ status, fact: f.kind, reopened: (f as { reopened?: boolean }).reopened ?? false, applied }).toEqual({ status, fact: f.kind, reopened: (f as { reopened?: boolean }).reopened ?? false, applied: expected });
      }
    }
  });
});
