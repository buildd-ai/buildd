import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * The pool draw glue. Predicates are rendered with the real PgDialect; only
 * the db CLIENT is stubbed.
 */

const fake = {
  pools: [] as any[],
  arms: [] as any[],
  priors: [] as any[],
  workspace: null as any,
  inserted: [] as any[],
  conflictTargets: [] as any[],
  throwOnSelect: false,
};

function nameOf(table: any): string {
  return table?.[Symbol.for('drizzle:Name')];
}

function rowsFor(table: any) {
  if (fake.throwOnSelect) throw new Error('db down');
  const n = nameOf(table);
  if (n === 'tier_pools') return fake.pools;
  if (n === 'tier_pool_arms') return fake.arms;
  return fake.priors;
}

mock.module('../db/client', () => ({
  db: {
    select: () => ({
      from: (table: any) => {
        const chain: any = {
          leftJoin: () => chain,
          where: () => {
            const p: any = Promise.resolve().then(() => rowsFor(table));
            p.limit = async () => rowsFor(table);
            return p;
          },
        };
        return chain;
      },
    }),
    insert: () => ({
      values: (v: any) => ({
        onConflictDoNothing: async (opts: any) => {
          fake.inserted.push(v);
          fake.conflictTargets.push(opts?.target);
        },
      }),
    }),
    query: { workspaces: { findFirst: async () => fake.workspace } },
  },
}));

const src = await import('../tier-pool-source');

const dialect = new PgDialect();
const render = (fragment: any) => {
  const q = dialect.sqlToQuery(fragment);
  return { sql: q.sql.replace(/\s+/g, ' ').trim().toLowerCase(), params: q.params };
};

const TEAM = 'team-1';
const EXP = '7a3d2c10-0000-4000-8000-0000000000aa';
const INC = '7a3d2c10-0000-4000-8000-0000000000a1';
const CH = '7a3d2c10-0000-4000-8000-0000000000a2';

function pool(over: Record<string, unknown> = {}) {
  return {
    id: 'pool-1', tier: 'standard', surface: 'agent', mode: 'split', frozenAt: null,
    experimentId: EXP, allocation: { [INC]: 0, [CH]: 1 }, allocationVersion: 4, policyVersion: 1, ...over,
  };
}
const arms = (poolId = 'pool-1') => [
  { id: CH, poolId, route: 'runner:claude', model: 'claude-opus-5', role: 'challenger', status: 'active', addedAt: new Date('2026-09-02') },
  { id: INC, poolId, route: 'runner:claude', model: 'claude-sonnet-5', role: 'incumbent', status: 'active', addedAt: new Date('2026-09-01') },
];

const agentArgs = (over: Partial<Parameters<typeof src.drawAgentPoolArm>[0]> = {}) => ({
  teamId: TEAM, tier: 'standard',
  task: { id: '7a3d2c10-0000-4000-8000-0000000000f1', taskClass: 'work', category: null, context: {} },
  workspace: { dataClass: 'standard', gitConfig: null }, workspaceOverride: false,
  explicitModel: null, roleModel: null, budgetPressure: 0.1, inModelRoutingExperiment: false,
  ...over,
});

beforeEach(() => {
  fake.pools = [];
  fake.arms = [];
  fake.priors = [];
  fake.workspace = null;
  fake.inserted = [];
  fake.conflictTargets = [];
  fake.throwOnSelect = false;
  src.invalidateTierPoolCache();
});

describe('predicates', () => {
  it('team pools are team-wide rows only', () => {
    const r = render(src.teamPoolsScope(TEAM));
    expect(r.sql).toContain('"tier_pools"."team_id" = $1');
    expect(r.sql).toContain('"tier_pools"."workspace_id" is null');
    expect(r.params).toEqual([TEAM]);
  });
  it('live arms exclude removed ones', () => {
    const r = render(src.liveArmsScope(['p1', 'p2']));
    expect(r.sql).toContain('"tier_pool_arms"."pool_id" in ($1, $2)');
    expect(r.sql).toContain('"tier_pool_arms"."status" <> $3');
    expect(r.params).toEqual(['p1', 'p2', 'removed']);
  });
  it('agent priors are this experiment\'s rows for the task, its parent, or its unit', () => {
    const r = render(src.agentPriorsScope(EXP, ['t1', 'p1'], 'm1'));
    expect(r.sql).toContain('"experiment_assignments"."experiment_id" = $1');
    expect(r.sql).toContain('"experiment_assignments"."task_id" in ($2, $3)');
    expect(r.sql).toContain('"experiment_assignments"."unit_id" = $4');
    expect(r.params).toEqual([EXP, 't1', 'p1', 'm1']);
  });
  it('the previous chat turn is looked up by message id within the pool', () => {
    const r = render(src.chatPreviousScope(EXP, 'msg-1'));
    expect(r.sql).toContain('"experiment_assignments"."message_id" = $2');
    expect(r.params).toEqual([EXP, 'msg-1']);
  });
});

describe('drawAgentPoolArm', () => {
  it('is null with no pool: the tier resolves as today', async () => {
    expect(await src.drawAgentPoolArm(agentArgs())).toBeNull();
  });

  it('draws a challenger by the current allocation and orders the incumbent first', async () => {
    fake.pools = [pool()];
    fake.arms = arms();
    const d = await src.drawAgentPoolArm(agentArgs());
    expect(d).toMatchObject({ source: 'drawn', propensity: 1, allocationVersion: 4, unitType: 'task', alreadyRecorded: false });
    expect(d!.arm.id).toBe(CH);
  });

  it('a pinned pool, a sensitive workspace and premium-plus never draw', async () => {
    fake.pools = [pool({ mode: 'pinned' })];
    fake.arms = arms();
    expect(await src.drawAgentPoolArm(agentArgs())).toBeNull();
    src.invalidateTierPoolCache();
    fake.pools = [pool()];
    expect(await src.drawAgentPoolArm(agentArgs({ workspace: { dataClass: 'sensitive' } }))).toBeNull();
    expect(await src.drawAgentPoolArm(agentArgs({ workspace: { dataClass: 'standard', gitConfig: { dataClass: 'sensitive' } } }))).toBeNull();
    fake.pools = [pool({ tier: 'premium-plus' })];
    src.invalidateTierPoolCache();
    expect(await src.drawAgentPoolArm(agentArgs({ tier: 'premium-plus' }))).toBeNull();
  });

  it('reviewer tasks and model-routing enrolees stay on the incumbent', async () => {
    fake.pools = [pool()];
    fake.arms = arms();
    expect(await src.drawAgentPoolArm(agentArgs({ task: { id: 't', category: 'review', context: {} } }))).toBeNull();
    expect(await src.drawAgentPoolArm(agentArgs({ inModelRoutingExperiment: true }))).toBeNull();
  });

  it('a re-claim reuses its row and writes nothing new', async () => {
    fake.pools = [pool()];
    fake.arms = arms();
    const task = agentArgs().task;
    fake.priors = [{ taskId: task.id, unitType: 'task', unitId: task.id, armId: INC, propensity: 0.8, allocationVersion: 2 }];
    const d = await src.drawAgentPoolArm(agentArgs());
    expect(d).toMatchObject({ source: 'existing', alreadyRecorded: true, propensity: 0.8, allocationVersion: 2 });
    await src.recordAgentPoolAssignment(d!, { taskId: task.id, resolvedModel: 'x', runnerCliVersion: null });
    expect(fake.inserted).toEqual([]);
  });

  it('never throws: a db failure serves the incumbent', async () => {
    fake.throwOnSelect = true;
    expect(await src.drawAgentPoolArm(agentArgs())).toBeNull();
  });
});

describe('applyAgentPoolArm', () => {
  async function drawn() {
    fake.pools = [pool()];
    fake.arms = arms();
    return (await src.drawAgentPoolArm(agentArgs()))!;
  }

  it('serves an active challenger on the task\'s backend', async () => {
    const d = await drawn();
    const r = src.applyAgentPoolArm(d, { incumbentModel: 'claude-sonnet-5', backend: 'claude', clientCanServe: () => true });
    expect(r).toEqual({ model: 'claude-opus-5', provider: 'anthropic' });
    expect(d).toMatchObject({ served: true, defaultModel: 'claude-sonnet-5', assignedModel: 'claude-opus-5' });
  });

  it('a backend mismatch or an old client serves the incumbent, served=false, never defers', async () => {
    const d = await drawn();
    expect(src.applyAgentPoolArm(d, { incumbentModel: 'm', backend: 'codex', clientCanServe: () => true })).toBeNull();
    expect(d).toMatchObject({ served: false, assignedModel: 'm', eligibility: expect.objectContaining({ fallback: 'backend_mismatch' }) });
    const d2 = await drawn();
    expect(src.applyAgentPoolArm(d2, { incumbentModel: 'm', backend: 'claude', clientCanServe: () => false })).toBeNull();
    expect(d2.eligibility).toMatchObject({ fallback: 'client_capability' });
  });

  it('records the assignment with arm id and allocation version', async () => {
    const d = await drawn();
    src.applyAgentPoolArm(d, { incumbentModel: 'claude-sonnet-5', backend: 'claude', clientCanServe: () => true });
    await src.recordAgentPoolAssignment(d, { taskId: 't1', resolvedModel: 'claude-opus-5', runnerCliVersion: '2.1.300' });
    expect(fake.inserted[0]).toMatchObject({
      experimentId: EXP, taskId: 't1', arm: CH, armId: CH, allocationVersion: 4, propensity: 1, served: true,
      assignedModel: 'claude-opus-5', defaultModel: 'claude-sonnet-5', unitType: 'task',
    });
  });
});

describe('drawChatPoolArm', () => {
  const now = new Date('2026-09-26T12:00:00Z');
  const chatArgs = (over: Partial<Parameters<typeof src.drawChatPoolArm>[0]> = {}) => ({
    teamId: TEAM, workspaceId: null, tier: 'standard', conversationId: 'c1', drawKey: 'c1#0',
    previous: null, workspaceOverride: false, now, ...over,
  });

  beforeEach(() => {
    fake.pools = [pool({ surface: 'chat' })];
    fake.arms = arms().map(a => ({ ...a, route: 'openrouter' }));
  });

  it('draws for a new chain', async () => {
    const d = await src.drawChatPoolArm(chatArgs());
    expect(d).toMatchObject({ source: 'drawn', served: false });
    expect(d!.arm.id).toBe(CH);
  });

  it('a following turn at the same tier keeps the chain\'s arm', async () => {
    fake.pools = [pool({ surface: 'chat', allocation: { [INC]: 1, [CH]: 0 } })];
    fake.priors = [{ armId: CH, propensity: 0.2 }];
    const d = await src.drawChatPoolArm(chatArgs({ previous: { id: 'm0', tier: 'standard', createdAt: new Date(now.getTime() - 60_000) } }));
    expect(d).toMatchObject({ source: 'chain', propensity: 0.2 });
    expect(d!.arm.id).toBe(CH);
  });

  it('a sensitive workspace is never enrolled', async () => {
    fake.workspace = { dataClass: 'sensitive', gitConfig: null };
    expect(await src.drawChatPoolArm(chatArgs({ workspaceId: 'ws-1' }))).toBeNull();
  });

  it('records one row per turn, keyed by message', async () => {
    const d = (await src.drawChatPoolArm(chatArgs()))!;
    await src.recordChatPoolAssignment(d, { messageId: 'm1' });
    expect(fake.inserted[0]).toMatchObject({ taskId: null, messageId: 'm1', conversationId: 'c1', unitType: 'conversation', unitId: 'c1', armId: CH });
  });
});
