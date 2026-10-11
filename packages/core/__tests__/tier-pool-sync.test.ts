import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * syncIncumbentToRegistry: the pool's incumbent arm mirrors the registry's
 * primary. The SQL client is stubbed; the statements are rendered with the
 * real PgDialect so the compare-and-set and audit row are what is asserted.
 */

const fake = {
  pool: null as any,
  arms: [] as any[],
  executed: [] as any[],
  /** allocation_version rows returned by the n-th execute; empty = CAS lost */
  results: [] as any[][],
  onExecute: null as null | ((n: number) => void),
};

function nameOf(table: any): string { return table?.[Symbol.for('drizzle:Name')]; }

mock.module('../db/client', () => ({
  db: {
    select: () => ({
      from: (table: any) => ({
        where: () => {
          const rows = nameOf(table) === 'tier_pools' ? (fake.pool ? [fake.pool] : []) : fake.arms;
          return Object.assign(Promise.resolve(rows), { limit: async () => rows });
        },
      }),
    }),
    execute: async (q: any) => { fake.executed.push(q); fake.onExecute?.(fake.executed.length); return { rows: fake.results.length ? fake.results.shift()! : [{ allocation_version: 8 }] }; },
  },
}));

const admin = await import('../tier-pool-admin');
const dialect = new PgDialect();
const render = (q: any) => { const r = dialect.sqlToQuery(q); return { sql: r.sql.replace(/\s+/g, ' ').trim(), params: r.params }; };

const INC = 'inc'; const ALT = 'alt';
const arm = (id: string, role: string, route: string, model: string) => ({ id, poolId: 'pool-1', route, model, role, status: 'active', addedAt: new Date('2026-08-01') });
const base = (over: Record<string, unknown> = {}) => ({
  id: 'pool-1', tier: 'budget', surface: 'chat', mode: 'split', allocation: { [INC]: 0.8, [ALT]: 0.2 },
  allocationVersion: 7, dial: 3, dialState: null, ...over,
});
const target = { route: 'openrouter' as const, model: 'deepseek/deepseek-v4.1-flash' };
const run = () => admin.syncIncumbentToRegistry({ teamId: 'team-1', tier: 'budget', surface: 'chat', primary: target, actorUserId: 'user-1' });

beforeEach(() => { fake.pool = null; fake.arms = []; fake.executed = []; fake.results = []; fake.onExecute = null; });

describe('syncIncumbentToRegistry', () => {
  it('does nothing for a tier with no pool yet', async () => {
    expect(await run()).toBe('none');
    expect(fake.executed).toHaveLength(0);
  });

  it('does nothing when the incumbent already is the primary', async () => {
    fake.pool = base();
    fake.arms = [arm(INC, 'incumbent', 'openrouter', target.model)];
    expect(await run()).toBe('none');
    expect(fake.executed).toHaveLength(0);
  });

  it('re-points a stale incumbent across providers in one audited CAS, keeping its id and share', async () => {
    fake.pool = base();
    fake.arms = [arm(INC, 'incumbent', 'anthropic', 'claude-haiku-4-5'), arm(ALT, 'challenger', 'openrouter', 'qwen/qwen3')];
    expect(await run()).toBe('synced');
    expect(fake.executed).toHaveLength(1);
    const { sql, params } = render(fake.executed[0]);
    expect(sql).toMatch(/WHERE id = \$\d+ AND team_id = \$\d+ AND allocation_version = \$\d+/);
    expect(sql).toContain('UPDATE tier_pool_arms SET route');
    expect(sql).toContain('EXISTS (SELECT 1 FROM u)');
    expect(sql).toContain('INSERT INTO tier_pool_changes');
    expect(params).toContain(7);
    expect(params).toContain('openrouter');
    expect(params).toContain(target.model);
    expect(params).toContain(JSON.stringify({ [INC]: 0.8, [ALT]: 0.2 })); // live split intent untouched
    expect(params).toContain(JSON.stringify({ reason: 'primary_changed', armId: INC }));
  });

  it('restarts a shifted dial cell in learning with all traffic on the new primary', async () => {
    fake.pool = base({ mode: 'dial', allocation: { [INC]: 0.7, [ALT]: 0.3 }, dialState: { state: 'shifted', alternateArmId: ALT, since: '2026-09-01T00:00:00Z' } });
    fake.arms = [arm(INC, 'incumbent', 'anthropic', 'claude-haiku-4-5'), arm(ALT, 'challenger', 'openrouter', 'qwen/qwen3')];
    expect(await run()).toBe('synced');
    const { params } = render(fake.executed[0]);
    expect(params).toContain(JSON.stringify({ [INC]: 1, [ALT]: 0 }));
    const dialState = params.find(p => typeof p === 'string' && p.includes('"learning"'));
    expect(dialState).toBeDefined();
    expect(JSON.parse(dialState as string).alternateArmId).toBeNull();
  });

  it('folds a challenger that is already the new primary into the incumbent first, then re-points it', async () => {
    fake.pool = base();
    fake.arms = [arm(INC, 'incumbent', 'anthropic', 'claude-haiku-4-5'), arm(ALT, 'challenger', 'openrouter', target.model)];
    // The first statement removes the duplicate; later reads no longer see it.
    fake.onExecute = (n) => { if (n === 1) fake.arms = fake.arms.filter(a => a.id !== ALT); };
    expect(await run()).toBe('synced');
    expect(fake.executed).toHaveLength(2);
    const removal = render(fake.executed[0]);
    expect(removal.sql).toContain("SET status = 'removed'");
    expect(removal.params).toContain(JSON.stringify({ [INC]: 1 })); // its share folded into the incumbent
    expect(render(fake.executed[1]).sql).toContain('UPDATE tier_pool_arms SET route');
  });

  it('reports stale, writing nothing, when concurrent admin writes keep winning the CAS', async () => {
    fake.pool = base();
    fake.arms = [arm(INC, 'incumbent', 'anthropic', 'claude-haiku-4-5')];
    fake.results = [[], [], []];
    expect(await run()).toBe('stale');
    expect(fake.executed).toHaveLength(3);
  });
});
