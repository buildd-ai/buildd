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

mock.module('../db/client', () => ({
  db: {
    execute: async (q: any) => { executed.push(q); return { rows: queue.length ? queue.shift()! : executeRows }; },
    select: () => ({ from: () => ({ where: async () => [] }) }),
  },
}));

const admin = await import('../tier-pool-admin');
const dialect = new PgDialect();
const render = (q: any) => {
  const r = dialect.sqlToQuery(q);
  return { sql: r.sql.replace(/\s+/g, ' ').trim(), params: r.params };
};

beforeEach(() => { executed.length = 0; executeRows = []; queue = []; });

describe('writeAllocation', () => {
  it('compare-and-sets the version, scoped to the team, and logs the change in the same statement', async () => {
    executeRows = [{ allocation_version: 5 }];
    const v = await admin.writeAllocation({
      teamId: 'team-1', poolId: 'pool-1', expectedVersion: 4, allocation: { a: 0.8, b: 0.2 },
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
    expect(params).toContain('user-1');
  });

  it('returns null when another admin wrote first', async () => {
    executeRows = [];
    expect(await admin.writeAllocation({ teamId: 't', poolId: 'p', expectedVersion: 1, allocation: {}, kind: 'mode', mode: 'pinned', actorUserId: null })).toBeNull();
  });
});

describe('addChallenger', () => {
  it('caps live arms at four in the insert itself and logs the add', async () => {
    executeRows = [{ id: 'arm-9' }];
    const r = await admin.addChallenger({ poolId: 'pool-1', route: 'openrouter', model: 'qwen/qwen3-coder', actorUserId: 'user-1' });
    expect(r).toEqual({ ok: true, armId: 'arm-9' });
    const { sql, params } = render(executed[0]);
    expect(sql).toContain("INSERT INTO tier_pool_arms");
    expect(sql).toMatch(/WHERE \(SELECT count\(\*\) FROM tier_pool_arms WHERE pool_id = \$\d+ AND status <> 'removed'\) < \$\d+/);
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(sql).toContain("'arm_added'");
    expect(params).toContain(4);
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
    expect(sql).toMatch(/AND allocation_version = \$\d+ AND EXISTS \(SELECT 1 FROM a\)/);
    expect(sql).toContain("'arm_removed'");
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
