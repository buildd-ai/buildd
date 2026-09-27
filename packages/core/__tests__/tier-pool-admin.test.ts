import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Admin writes for tier pools. Each traffic change must be ONE statement that
 * compare-and-sets the allocation version and appends its audit row, so the
 * SQL itself is what is asserted (rendered with the real PgDialect).
 */

const executed: any[] = [];
let executeRows: any[] = [];
let queue: any[][] = [];
let selectQueue: any[][] = [];

mock.module('../db/client', () => ({
  db: {
    execute: async (q: any) => { executed.push(q); return { rows: queue.length ? queue.shift()! : executeRows }; },
    select: () => ({ from: () => ({ where: async () => (selectQueue.length ? selectQueue.shift()! : []) }) }),
  },
}));

const admin = await import('../tier-pool-admin');
const dialect = new PgDialect();
const render = (q: any) => {
  const r = dialect.sqlToQuery(q);
  return { sql: r.sql.replace(/\s+/g, ' ').trim(), params: r.params };
};

beforeEach(() => { executed.length = 0; executeRows = []; queue = []; selectQueue = []; });

describe('writeAllocation', () => {
  it('compare-and-sets the version, scoped to the team, and logs the change (with weights) in the same statement', async () => {
    executeRows = [{ allocation_version: 5 }];
    const v = await admin.writeAllocation({
      teamId: 'team-1', poolId: 'pool-1', expectedVersion: 4, allocation: { a: 0.8, b: 0.2 }, weights: { a: 'high', b: 'low' },
      mode: 'split', kind: 'allocation', actorUserId: 'user-1',
    });
    expect(v).toBe(5);
    const { sql, params } = render(executed[0]);
    expect(sql).toContain('UPDATE tier_pools');
    expect(sql).toContain('allocation_version = allocation_version + 1');
    expect(sql).toMatch(/WHERE id = \$\d+ AND team_id = \$\d+ AND allocation_version = \$\d+/);
    expect(sql).toContain('INSERT INTO tier_pool_changes');
    expect(sql).toContain('FROM u, prev');
    expect(params).toContain(4);
    expect(params).toContain('team-1');
    expect(params).toContain(JSON.stringify({ a: 0.8, b: 0.2 }));
    expect(params).toContain(JSON.stringify({ a: 'high', b: 'low' }));
    expect(params).toContain('user-1');
  });

  it('leaves stored weights untouched when none are passed (a mode-only or arm-removal write)', async () => {
    executeRows = [{ allocation_version: 5 }];
    await admin.writeAllocation({ teamId: 'team-1', poolId: 'pool-1', expectedVersion: 4, allocation: { a: 1 }, kind: 'mode', mode: 'pinned', actorUserId: 'user-1' });
    const { sql } = render(executed[0]);
    expect(sql).toContain('weights = COALESCE(');
  });

  it('returns null when another admin wrote first', async () => {
    executeRows = [];
    expect(await admin.writeAllocation({ teamId: 't', poolId: 'p', expectedVersion: 1, allocation: {}, kind: 'mode', mode: 'pinned', actorUserId: null })).toBeNull();
  });
});

describe('addChallenger', () => {
  it('caps live arms at four in the insert itself', async () => {
    queue = [[{ id: 'arm-9' }]];
    const r = await admin.addChallenger({ teamId: 'team-1', poolId: 'pool-1', route: 'openrouter', model: 'qwen/qwen3-coder', weight: 'med', actorUserId: 'user-1' });
    expect(r).toEqual({ ok: true, armId: 'arm-9' });
    const { sql, params } = render(executed[0]);
    expect(sql).toContain("INSERT INTO tier_pool_arms");
    expect(sql).toMatch(/WHERE \(SELECT count\(\*\) FROM tier_pool_arms WHERE pool_id = \$\d+ AND status <> 'removed'\) < \$\d+/);
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(params).toContain(4);
  });

  it("folds the new arm into the pool's weights and writes the resulting allocation in a second statement", async () => {
    queue = [[{ id: 'arm-9' }], [{ allocation_version: 6 }]];
    selectQueue = [
      [{ allocationVersion: 5, weights: { inc: 'high' }, allocation: { inc: 1 } }],
      [{ id: 'inc', role: 'incumbent', addedAt: new Date('2026-01-01T00:00:00Z') }, { id: 'arm-9', role: 'challenger', addedAt: new Date('2026-01-02T00:00:00Z') }],
    ];
    const r = await admin.addChallenger({ teamId: 'team-1', poolId: 'pool-1', route: 'openrouter', model: 'qwen/qwen3-coder', weight: 'low', actorUserId: 'user-1' });
    expect(r).toEqual({ ok: true, armId: 'arm-9' });
    const { sql, params } = render(executed[1]);
    expect(sql).toContain('UPDATE tier_pools');
    expect(params).toContain(JSON.stringify({ inc: 0.75, 'arm-9': 0.25 }));
    expect(params).toContain(JSON.stringify({ inc: 'high', 'arm-9': 'low' }));
  });

  it("backfills a legacy pool's missing weights from its live share before folding in the new arm", async () => {
    queue = [[{ id: 'arm-9' }], [{ allocation_version: 6 }]];
    selectQueue = [
      // A pool created before this feature shipped: weights = {}.
      [{ allocationVersion: 3, weights: {}, allocation: { inc: 1 } }],
      [{ id: 'inc', role: 'incumbent', addedAt: new Date('2026-01-01T00:00:00Z') }, { id: 'arm-9', role: 'challenger', addedAt: new Date('2026-01-02T00:00:00Z') }],
    ];
    await admin.addChallenger({ teamId: 'team-1', poolId: 'pool-1', route: 'openrouter', model: 'qwen/qwen3-coder', weight: 'low', actorUserId: 'user-1' });
    const { params } = render(executed[1]);
    // inc's 100% share snaps to `high`, so it is not zeroed out by the new arm.
    expect(params).toContain(JSON.stringify({ inc: 'high', 'arm-9': 'low' }));
  });
});

describe('removeChallenger', () => {
  it('only removes a challenger, only at the expected version, and logs it', async () => {
    executeRows = [{ allocation_version: 7 }];
    const v = await admin.removeChallenger({ teamId: 'team-1', poolId: 'pool-1', armId: 'arm-2', expectedVersion: 6, allocation: { a: 1 }, actorUserId: 'user-1' });
    expect(v).toBe(7);
    const { sql } = render(executed[0]);
    expect(sql).toContain("role = 'challenger'");
    expect(sql).toContain("SET status = 'removed'");
    expect(sql).toContain("'arm_removed'");
  });

  it('decides on the pool version before any arm row changes', async () => {
    // The pool row lock orders concurrent admin writes. The arm may flip only
    // after this statement's own version compare-and-set succeeded, so a stale
    // remove can never leave a removed arm still holding a share, unlogged.
    executeRows = [{ allocation_version: 7 }];
    await admin.removeChallenger({ teamId: 'team-1', poolId: 'pool-1', armId: 'arm-2', expectedVersion: 6, allocation: { a: 1 }, actorUserId: 'user-1' });
    const { sql } = render(executed[0]);
    const poolUpdate = sql.indexOf('UPDATE tier_pools');
    const armUpdate = sql.indexOf('UPDATE tier_pool_arms');
    expect(poolUpdate).toBeGreaterThan(-1);
    expect(armUpdate).toBeGreaterThan(poolUpdate);
    const armStmt = sql.slice(armUpdate, sql.indexOf('RETURNING', armUpdate));
    expect(armStmt).toContain('EXISTS (SELECT 1 FROM u)');
    expect(armStmt).not.toContain('allocation_version');
    const poolStmt = sql.slice(poolUpdate, sql.indexOf('RETURNING', poolUpdate));
    expect(poolStmt).toMatch(/allocation_version = \$\d+/);
    expect(poolStmt).toContain("role = 'challenger'");
  });
});

describe('scopes', () => {
  it('a pool is only ever read or written inside its team', () => {
    const { sql, params } = render(admin.ownedPoolScope('team-1', 'pool-1'));
    expect(sql).toBe('("tier_pools"."id" = $1 and "tier_pools"."team_id" = $2)');
    expect(params).toEqual(['pool-1', 'team-1']);
  });
  it('the team pool for a tier and surface is the workspace-less row', () => {
    const { sql } = render(admin.teamPoolScope('team-1', 'standard', 'chat'));
    expect(sql).toContain('"tier_pools"."workspace_id" is null');
    expect(sql).toContain('"tier_pools"."surface" = $3');
  });
});

describe('loadArmStats', () => {
  it('joins agent assignments to their latest outcome and chat turns to usage and thumbs, team-scoped', async () => {
    executeRows = [];
    await admin.loadArmStats('team-1', new Date('2026-09-26T00:00:00Z'));
    const [agent, chat] = executed.map(render);
    expect(agent.sql).toContain("p.team_id = $1 AND p.surface = 'agent'");
    expect(agent.sql).toContain('ORDER BY created_at DESC LIMIT 1');
    expect(chat.sql).toContain("p.team_id = $1 AND p.surface = 'chat'");
    expect(chat.sql).toContain("f.entity_type = 'conversation_message'");
    expect(agent.params).toEqual(['team-1', '2026-08-27T00:00:00.000Z']);
  });

  it('summarises per arm: failures from infra are not graded, thumbs set chat severity', async () => {
    const agentRows = [
      { arm_id: 'a', outcome: 'completed', exit_cause: null, total_cost_usd: '0.40', duration_ms: 1000 },
      { arm_id: 'a', outcome: 'failed', exit_cause: 'infra_failure', total_cost_usd: null, duration_ms: null },
      { arm_id: 'a', outcome: 'failed', exit_cause: 'error', total_cost_usd: '0.20', duration_ms: 3000 },
    ];
    const chatRows = [
      { arm_id: 'c', usage: { costUsd: 0.01, latencyMs: 900 }, signal: 'up', reason: null },
      { arm_id: 'c', usage: { costUsd: 0.03, latencyMs: 1100 }, signal: 'down', reason: 'made_up' },
      { arm_id: 'c', usage: { costUsd: 0.02 }, signal: null, reason: null },
    ];
    queue = [agentRows, chatRows];
    const stats = await admin.loadArmStats('team-1');
    expect(stats.get('a')).toMatchObject({ units: 3, graded: 2, wins: 1, severity: { none: 1, major: 1 } });
    expect(stats.get('a')!.costPer1k).toBeCloseTo(300);
    expect(stats.get('c')).toMatchObject({ units: 3, graded: 2, wins: 1, severity: { none: 1, major: 1 }, latencyP50Ms: 1000 });
    expect(stats.get('c')!.costPer1k).toBeCloseTo(20);
  });
});
