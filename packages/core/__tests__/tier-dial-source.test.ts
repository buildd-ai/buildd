import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * The dial's stores half. The SQL client is stubbed; selects return the
 * fixture rows by table, executes return run/verdict rows or record writes.
 */

const fake = {
  pools: [] as any[],
  arms: [] as any[],
  runs: [] as any[],
  verdicts: [] as any[],
  writes: [] as string[],
  writeReturns: [{ allocation_version: 9 }] as any[],
};

function nameOf(table: any): string {
  return table?.[Symbol.for('drizzle:Name')];
}

const dialect = new PgDialect();
const text = (q: any) => dialect.sqlToQuery(q).sql.replace(/\s+/g, ' ');

mock.module('../db/client', () => ({
  db: {
    select: () => ({
      from: (table: any) => ({
        where: async () => (nameOf(table) === 'tier_pools' ? fake.pools : fake.arms),
      }),
    }),
    execute: async (q: any) => {
      const s = text(q);
      if (s.includes('FROM task_outcomes')) return { rows: fake.runs };
      if (s.includes("context ? 'reviewerFor'") && s.includes('effectiveVerdict')) return { rows: fake.verdicts };
      fake.writes.push(s);
      return { rows: s.includes('allocation_version = allocation_version + 1') ? fake.writeReturns : [] };
    },
  },
}));

const src = await import('../tier-dial-source');
const { DIAL_SETTINGS } = await import('../tier-dial');

const NOW = new Date('2026-10-06T12:00:00Z');
const DAY = 86_400_000;
const INC = 'inc-arm';
const ALT = 'alt-arm';

const arms = () => [
  { id: INC, poolId: 'pool-1', model: 'primary-model', role: 'incumbent', status: 'active', addedAt: new Date('2026-08-01') },
  { id: ALT, poolId: 'pool-1', model: 'cheap-model', role: 'challenger', status: 'active', addedAt: new Date('2026-08-02') },
];

/** `n` finished runs on `model` in `tier`, `mergedShare` of them merged, review approve on merged ones. */
function runs(model: string, tier: string, n: number, mergedShare: number, cost = '1', startDaysAgo = 20) {
  return Array.from({ length: n }, (_, i) => ({
    task_id: `${model}-${tier}-${i}`,
    at: new Date(NOW.getTime() - startDaysAgo * DAY + i * 60_000).toISOString(),
    tier, model, outcome: 'completed', exit_cause: null, cost,
    merged: i < Math.round(n * mergedShare), closed: i >= Math.round(n * mergedShare),
  }));
}

beforeEach(() => {
  fake.pools = [];
  fake.arms = [];
  fake.runs = [];
  fake.verdicts = [];
  fake.writes = [];
  fake.writeReturns = [{ allocation_version: 9 }];
});

describe('sameModel', () => {
  it('matches an id and its dated spelling, nothing looser', () => {
    expect(src.sameModel('claude-x-4-5', 'claude-x-4-5-20251001')).toBe(true);
    expect(src.sameModel('claude-x-4-5', 'claude-x-4-5')).toBe(true);
    expect(src.sameModel('claude-x-4', 'claude-x-4-5')).toBe(true); // prefix + '-': same family spelling
    expect(src.sameModel('claude-x', 'claude-y')).toBe(false);
    expect(src.sameModel(null, 'a')).toBe(false);
  });
});

describe('loadTeamCodingRuns', () => {
  it('attaches reviewer verdicts oldest first', async () => {
    fake.runs = runs('m', 'standard', 1, 1);
    fake.verdicts = [
      { for_task: 'm-standard-0', at: '2026-10-02T00:00:00Z', verdict: 'approve' },
      { for_task: 'm-standard-0', at: '2026-10-01T00:00:00Z', verdict: 'request-changes' },
    ];
    const [r] = await src.loadTeamCodingRuns('team-1', new Date(0));
    expect(r.verdicts).toEqual(['request-changes', 'approve']);
    expect(r.merged).toBe(true);
  });
});

describe('runDialStep', () => {
  const pool = (over: Record<string, unknown> = {}) => ({
    id: 'pool-1', teamId: 'team-1', tier: 'standard', dial: 5,
    dialState: { state: 'learning', since: '2026-09-01T00:00:00Z' },
    allocation: { [INC]: 1, [ALT]: 0 }, allocationVersion: 4, ...over,
  });

  it('promotes a learning cell whose alternate keeps up, as one audited compare-and-set', async () => {
    fake.pools = [pool()];
    fake.arms = arms();
    fake.runs = [...runs('primary-model', 'standard', 60, 0.7, '2'), ...runs('cheap-model', 'budget', 60, 0.7, '0.2')];
    const s = await src.runDialStep({ now: NOW });
    expect(s.transitions).toEqual([{ poolId: 'pool-1', kind: 'promotion', to: 'shifted' }]);
    const w = fake.writes.find(x => x.includes('allocation_version = allocation_version + 1'))!;
    expect(w).toContain('INSERT INTO tier_pool_changes');
    expect(w).toContain('allocation_version = $');
  });

  it('a learning cell with too few runs moves no traffic and writes no change row', async () => {
    fake.pools = [pool()];
    fake.arms = arms();
    fake.runs = [...runs('primary-model', 'standard', 5, 0.7), ...runs('cheap-model', 'budget', 5, 1)];
    const s = await src.runDialStep({ now: NOW });
    expect(s.transitions).toEqual([]);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]).not.toContain('tier_pool_changes');
    expect(fake.writes[0]).toContain('dial_state');
  });

  it('reverts a shifted cell whose own runs slipped', async () => {
    const shiftedAt = new Date(NOW.getTime() - 10 * DAY).toISOString();
    fake.pools = [pool({ dial: 3, dialState: { state: 'shifted', since: shiftedAt, alternateArmId: ALT }, allocation: { [INC]: 0.5, [ALT]: 0.5 } })];
    fake.arms = arms();
    fake.runs = [
      ...runs('primary-model', 'standard', 30, 0.8, '2', 5),
      ...runs('cheap-model', 'standard', 30, 0.4, '0.2', 5),
    ];
    const s = await src.runDialStep({ now: NOW });
    expect(s.transitions).toEqual([{ poolId: 'pool-1', kind: 'revert', to: 'reverted' }]);
  });

  it('a stale write is counted, not retried blindly', async () => {
    fake.pools = [pool()];
    fake.arms = arms();
    fake.runs = [...runs('primary-model', 'standard', 60, 0.7, '2'), ...runs('cheap-model', 'budget', 60, 0.7, '0.2')];
    fake.writeReturns = [];
    const s = await src.runDialStep({ now: NOW });
    expect(s.stale).toBe(1);
    expect(s.transitions).toEqual([]);
  });
});

describe('dialInputFor', () => {
  it('primary evidence is the cell only; alternate evidence is the team\'s runs on that model anywhere', async () => {
    const all = [...runs('primary-model', 'standard', 10, 1), ...runs('primary-model', 'premium', 10, 0), ...runs('cheap-model', 'budget', 7, 1)];
    fake.runs = all;
    const loaded = await src.loadTeamCodingRuns('team-1', new Date(0));
    const input = src.dialInputFor({
      id: 'p', teamId: 't', tier: 'standard', dial: 3, dialState: null, allocation: {}, allocationVersion: 1,
      arms: arms() as any,
    }, loaded, NOW)!;
    expect(input.primary.evidence.rates.merged).toEqual({ n: 10, k: 10 });
    expect(input.alternates[0].evidence.rates.merged).toEqual({ n: 7, k: 7 });
    expect(input.alternates[0].inCell.rates.merged.n).toBe(0);
  });

  it('after a revert only evidence since the revert counts', async () => {
    fake.runs = runs('cheap-model', 'budget', 10, 1, '1', 20);
    const loaded = await src.loadTeamCodingRuns('team-1', new Date(0));
    const since = new Date(NOW.getTime() - 5 * DAY).toISOString();
    const input = src.dialInputFor({
      id: 'p', teamId: 't', tier: 'standard', dial: 3,
      dialState: { state: 'learning', since, evidenceSince: since }, allocation: {}, allocationVersion: 1, arms: arms() as any,
    }, loaded, NOW)!;
    expect(input.alternates[0].evidence.rates.merged.n).toBe(0);
  });
});

describe('whatRan', () => {
  it('reports share, rates and cost per model, folding dated spellings', async () => {
    fake.runs = [...runs('m-1', 'standard', 3, 1, '2'), ...runs('m-1-20260101', 'standard', 1, 0, '2'), ...runs('other', 'standard', 4, 0.5, '1')];
    const loaded = await src.loadTeamCodingRuns('team-1', new Date(0));
    const out = src.whatRan(loaded);
    const m1 = out.find(r => r.model === 'm-1')!;
    expect(m1.runs).toBe(4);
    expect(m1.share).toBeCloseTo(0.5, 6);
    expect(m1.mergedRate).toBeCloseTo(0.75, 6);
    expect(m1.costPerRunUsd).toBe(2);
    expect(m1.recentRuns.length).toBeLessThanOrEqual(5);
  });
});

describe('dial settings', () => {
  it('dial 5 can take every eligible run, dial 2 a quarter', () => {
    expect(DIAL_SETTINGS[5].maxShare).toBe(1);
    expect(DIAL_SETTINGS[2].maxShare).toBe(0.25);
  });
});
