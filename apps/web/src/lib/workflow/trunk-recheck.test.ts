/**
 * The trunk incident recheck queue (trunk-recheck.ts, workflow-kernel-library.md §3, T26): a base going
 * green between hourly floors is read within a tick of its suite completing, or within the fallback when
 * that event is lost. Redis is a stub; the recheck itself (seam `recheckTrunkIncidents`) runs on Postgres
 * in tests/db/workflow-matrix.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const due = new Map<string, number>();
let redisDown = false;
mock.module('@/lib/redis', () => ({
  markDueEarliest: async (_job: string, member: string, at: number) => { const p = due.get(member); if (p === undefined || at < p) due.set(member, at); },
  clearDue: async (_job: string, members: string | string[]) => { for (const m of [members].flat()) due.delete(m); },
  countDue: async (_job: string, now: number) => (redisDown ? null : [...due.values()].filter((t) => t <= now).length),
  listDue: async (_job: string, now: number, limit: number) => [...due.entries()].filter(([, t]) => t <= now).sort((a, b) => a[1] - b[1]).slice(0, limit).map(([m]) => m),
}));

const { TRUNK_RECHECK_BATCH, TRUNK_RECHECK_FALLBACK_MS, requestTrunkRecheckForBranch, runDueTrunkRechecks, scheduleTrunkRecheck, unresolvedIncidentsOnBranchSql } = await import('./trunk-recheck');

const T0 = 1_800_000_000_000;
beforeEach(() => { due.clear(); redisDown = false; });

const recorder = (unresolved: (ids: string[]) => string[] = () => []) => {
  const calls: string[][] = [];
  return { calls, recheck: async (ids: string[]) => { calls.push([...ids]); return { unresolved: unresolved(ids) }; } };
};

describe('the recheck tick', () => {
  test('nothing due: no recheck runs (no Postgres, no GitHub read)', async () => {
    await scheduleTrunkRecheck('i1', T0 + TRUNK_RECHECK_FALLBACK_MS);
    const r = recorder();
    expect(await runDueTrunkRechecks({ recheck: r.recheck, now: () => T0 })).toEqual({ due: 0, rechecked: 0, requeued: 0, failed: 0 });
    expect(r.calls).toEqual([]);
  });

  test('Redis unreadable: null, and no recheck', async () => {
    redisDown = true;
    const r = recorder();
    expect(await runDueTrunkRechecks({ recheck: r.recheck, now: () => T0 })).toBeNull();
    expect(r.calls).toEqual([]);
  });

  test('a base suite completing makes the branch\'s incidents due now: the next minute\'s tick rechecks them', async () => {
    // The incident was opened at T0 and queued at the fallback; its base goes green at T0 + 90 s.
    await scheduleTrunkRecheck('i1', T0 + TRUNK_RECHECK_FALLBACK_MS);
    const exec = async () => ({ rows: [{ id: 'i1' }] });
    expect(await requestTrunkRecheckForBranch({ repoFullName: 'acme/r', branch: 'dev' }, { exec, now: T0 + 90_000 })).toBe(1);
    const r = recorder();
    // The next per-minute tick, well inside two minutes of the suite.
    expect(await runDueTrunkRechecks({ recheck: r.recheck, now: () => T0 + 120_000 })).toMatchObject({ due: 1, rechecked: 1, requeued: 0 });
    expect(r.calls).toEqual([['i1']]);
    // Resolved: off the queue.
    expect(due.has('i1')).toBe(false);
  });

  test('a lost completion event: the fallback rechecks it within one period', async () => {
    await scheduleTrunkRecheck('i1', T0 + TRUNK_RECHECK_FALLBACK_MS);
    const r = recorder();
    expect(await runDueTrunkRechecks({ recheck: r.recheck, now: () => T0 + TRUNK_RECHECK_FALLBACK_MS - 1 })).toMatchObject({ due: 0 });
    expect(await runDueTrunkRechecks({ recheck: r.recheck, now: () => T0 + TRUNK_RECHECK_FALLBACK_MS })).toMatchObject({ due: 1, rechecked: 1 });
    expect(r.calls).toEqual([['i1']]);
    expect(TRUNK_RECHECK_FALLBACK_MS).toBeLessThanOrEqual(5 * 60_000);
  });

  test('an incident still red (or unknown) goes back on the queue at the fallback, never dropped', async () => {
    await scheduleTrunkRecheck('i1', T0);
    const r = recorder((ids) => ids);
    expect(await runDueTrunkRechecks({ recheck: r.recheck, now: () => T0 })).toMatchObject({ due: 1, rechecked: 1, requeued: 1 });
    expect(due.get('i1')).toBe(T0 + TRUNK_RECHECK_FALLBACK_MS);
  });

  test('a suite completing during the recheck keeps the incident due now: the re-queue never pushes it back', async () => {
    await scheduleTrunkRecheck('i1', T0);
    const exec = async () => ({ rows: [{ id: 'i1' }] });
    const recheck = async (ids: string[]) => {
      // The base's last suite finishes while this tick is reading the earlier head.
      await requestTrunkRecheckForBranch({ repoFullName: 'acme/r', branch: 'dev' }, { exec, now: T0 + 5_000 });
      return { unresolved: ids };
    };
    await runDueTrunkRechecks({ recheck, now: () => T0 });
    expect(due.get('i1')).toBe(T0 + 5_000);
  });

  test('a recheck that throws re-queues every incident it took at the fallback', async () => {
    await scheduleTrunkRecheck('i1', T0);
    await scheduleTrunkRecheck('i2', T0);
    const out = await runDueTrunkRechecks({ recheck: async () => { throw new Error('db down'); }, now: () => T0 });
    expect(out).toMatchObject({ due: 2, failed: 2 });
    expect(due.get('i1')).toBe(T0 + TRUNK_RECHECK_FALLBACK_MS);
    expect(due.get('i2')).toBe(T0 + TRUNK_RECHECK_FALLBACK_MS);
  });

  test('bounded: one tick rechecks at most a batch, oldest due first; the rest wait for the next tick', async () => {
    for (let i = 0; i < TRUNK_RECHECK_BATCH + 3; i++) await scheduleTrunkRecheck(`i${i}`, T0 - 1000 + i);
    const r = recorder();
    expect(await runDueTrunkRechecks({ recheck: r.recheck, now: () => T0 })).toMatchObject({ due: TRUNK_RECHECK_BATCH });
    expect(r.calls[0]).toEqual(Array.from({ length: TRUNK_RECHECK_BATCH }, (_, i) => `i${i}`));
    expect(due.size).toBe(3);
  });

  test('duplicate events queue one member; one tick rechecks it once', async () => {
    const exec = async () => ({ rows: [{ id: 'i1' }] });
    for (let i = 0; i < 3; i++) await requestTrunkRecheckForBranch({ repoFullName: 'acme/r', branch: 'dev' }, { exec, now: T0 + i });
    const r = recorder();
    await runDueTrunkRechecks({ recheck: r.recheck, now: () => T0 + 60_000 });
    expect(r.calls).toEqual([['i1']]);
  });
});

describe('the completion request', () => {
  test('reads the branch\'s unresolved incidents in any workspace, bounded (rendered through PgDialect)', () => {
    const q = new PgDialect().sqlToQuery(unresolvedIncidentsOnBranchSql('acme/r', 'dev'));
    expect(q.sql.replace(/\s+/g, ' ')).toContain("WHERE repo_full_name = $1::text AND base_ref = $2::text AND status <> 'resolved' LIMIT $3::int");
    expect(q.sql).not.toContain('workspace_id');
    expect(q.params.slice(0, 2)).toEqual(['acme/r', 'dev']);
  });

  test('a branch with no unresolved incident queues nothing', async () => {
    expect(await requestTrunkRecheckForBranch({ repoFullName: 'acme/r', branch: 'feat/x' }, { exec: async () => ({ rows: [] }), now: T0 })).toBe(0);
    expect(due.size).toBe(0);
  });

  test('a failed read never throws: the fallback and the floor back it', async () => {
    expect(await requestTrunkRecheckForBranch({ repoFullName: 'acme/r', branch: 'dev' }, { exec: async () => { throw new Error('db down'); }, now: T0 })).toBe(0);
  });
});
