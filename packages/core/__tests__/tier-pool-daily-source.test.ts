import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema';

/**
 * The daily step's stores half: which pools run, once per UTC day, and that
 * every change goes through the compare-and-set write with a system actor.
 * The db is a fake keyed on the table each query reads.
 */

let poolRows: any[] = [];
let armRows: any[] = [];
const cache = new Map<string, any>();
const executed: any[] = [];
const writes: any[] = [];
let writeVersion: number | null = 8;
const refreshCalls: any[] = [];

function builder() {
  const b: any = {
    table: null,
    from(t: unknown) { b.table = t; return b; },
    innerJoin() { return b; },
    leftJoin() { return b; },
    where() { return b; },
    limit() { return b; },
    then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
      let rows: unknown[] = [];
      if (b.table === schema.tierPools) rows = poolRows;
      else if (b.table === schema.tierPoolArms) rows = armRows;
      else if (b.table === schema.systemCache) rows = [...cache.entries()].map(([key, value]) => ({ key, value }));
      return Promise.resolve(rows).then(res, rej);
    },
  };
  return b;
}

mock.module('../db/client', () => ({
  db: {
    select: () => builder(),
    execute: async (q: unknown) => { executed.push(q); return { rows: [] }; },
    insert: (t: unknown) => ({
      values: (v: any) => ({
        onConflictDoUpdate: async () => { if (t === schema.systemCache) cache.set(v.key, v.value); },
      }),
    }),
  },
}));
mock.module('../tier-pool-admin', () => ({
  writeAllocation: async (a: any) => { writes.push(a); return writeVersion; },
}));
mock.module('../model-catalog-cache', () => ({ getCachedOpenRouterCatalog: async () => [] }));
mock.module('../openrouter-rankings-source', () => ({
  refreshTeamRankings: async (a: any) => { refreshCalls.push(a); return { status: 'fetched', written: ['text'], failed: [], unmapped: 0 }; },
  loadTeamRankings: async () => ({}),
}));

const src = await import('../tier-pool-daily-source');
const dialect = new PgDialect();

const AT_SIX = new Date('2026-09-27T06:00:00Z');

beforeEach(() => {
  poolRows = [{
    id: 'pool-1', teamId: 'team-1', tier: 'standard', surface: 'agent', mode: 'explore',
    allocation: { inc: 1, ch: 0 }, allocationVersion: 7, autoChallenger: false, policyVersion: 1,
  }];
  armRows = [
    { id: 'inc', poolId: 'pool-1', route: 'runner:claude', model: 'claude-sonnet-5', role: 'incumbent', status: 'active', source: 'registry', addedAt: '2026-06-01T00:00:00Z', stats: {} },
    { id: 'ch', poolId: 'pool-1', route: 'runner:claude', model: 'claude-opus-5', role: 'challenger', status: 'active', source: 'admin', addedAt: '2026-09-25T00:00:00Z', stats: {} },
  ];
  cache.clear();
  executed.length = 0;
  writes.length = 0;
  refreshCalls.length = 0;
  writeVersion = 8;
});

describe('runTierPoolsDaily', () => {
  it('writes an explore step through compare-and-set with a system actor and replayable evidence', async () => {
    const s = await src.runTierPoolsDaily({ now: AT_SIX });
    expect(s).toMatchObject({ pools: 1, stepped: 1, written: 1, errors: 0 });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      teamId: 'team-1', poolId: 'pool-1', expectedVersion: 7, kind: 'allocation',
      allocation: { inc: 0.9, ch: 0.1 }, actorUserId: null, actorSystem: 'system:explore',
    });
    expect(writes[0].evidence).toMatchObject({ policy: 'explore-v1', date: '2026-09-27', seed: 'pool-1:1:2026-09-27' });
    expect(cache.get(src.stepMarkerKey('pool-1'))).toEqual({ date: '2026-09-27' });
  });

  it('is idempotent: a second run the same day writes nothing', async () => {
    await src.runTierPoolsDaily({ now: AT_SIX });
    writes.length = 0;
    const again = await src.runTierPoolsDaily({ now: new Date('2026-09-27T07:00:00Z') });
    expect(again.stepped).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it('runs again the next day', async () => {
    cache.set(src.stepMarkerKey('pool-1'), { date: '2026-09-26' });
    await src.runTierPoolsDaily({ now: AT_SIX });
    expect(writes).toHaveLength(1);
  });

  it('does not step before 06:00 UTC', async () => {
    const s = await src.runTierPoolsDaily({ now: new Date('2026-09-27T05:00:00Z') });
    expect(s.stepped).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it('a stale write (an admin changed the pool meanwhile) leaves the day open for a retry', async () => {
    writeVersion = null;
    const s = await src.runTierPoolsDaily({ now: AT_SIX });
    expect(s.stale).toBe(1);
    expect(s.written).toBe(0);
    expect(cache.has(src.stepMarkerKey('pool-1'))).toBe(false);
  });

  it('refreshes rankings only for teams with an explore pool', async () => {
    poolRows = [{ ...poolRows[0], mode: 'split' }];
    await src.runTierPoolsDaily({ now: AT_SIX });
    expect(refreshCalls).toHaveLength(0);
  });

  it('no pools: one query, nothing else', async () => {
    poolRows = [];
    const s = await src.runTierPoolsDaily({ now: AT_SIX });
    expect(s.pools).toBe(0);
    expect(executed).toHaveLength(0);
  });
});

describe('writeSuggestion', () => {
  it('writes a suggestion row once per key, and never over a dismissal', async () => {
    await src.writeSuggestion('pool-1', 'succession:inc:claude-sonnet-5-1', 'system:succession', { signal: 'succession' });
    const q = dialect.sqlToQuery(executed[0] as never);
    const sql = q.sql.replace(/\s+/g, ' ');
    expect(sql).toContain("INSERT INTO tier_pool_changes (pool_id, kind, evidence, actor_system)");
    expect(sql).toContain("'suggestion'");
    expect(sql).toContain("kind IN ('suggestion', 'suggestion_dismissed') AND evidence->>'key' =");
    expect(q.params).toContain('system:succession');
  });
});

describe('addAutoChallenger', () => {
  it('respects the four-arm cap and logs arm_added as system:succession', async () => {
    await src.addAutoChallenger('pool-1', 'runner:claude', 'claude-sonnet-5-1', { signal: 'succession' });
    const sql = dialect.sqlToQuery(executed[0] as never).sql.replace(/\s+/g, ' ');
    expect(sql).toContain("'auto_challenger'");
    expect(sql).toMatch(/< \$\d+/);
    expect(sql).toContain("'arm_added'");
    expect(sql).toContain("'system:succession'");
  });
});
