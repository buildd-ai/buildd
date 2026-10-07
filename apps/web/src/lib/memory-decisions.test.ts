import { describe, expect, it } from 'bun:test';
import {
  createRelevanceShadow,
  createRelevanceJudge,
  memoryRelevanceLiveEnabled,
  decisionUsageRow,
  scheduleAfter,
  scheduleMemoryUseLabels,
  webMemoryDecisionDeps,
  shouldLabelMemoryUses,
  relevanceShadowSampleRate,
  memoryDecisionsDisabled,
} from './memory-decisions';
import type { MemoryDecider } from '@buildd/core/memory-decisions';

const TEAM = 'bbbb0000-0000-0000-0000-000000000001';
const WS = 'aaaa0000-0000-0000-0000-000000000000';
const TASK = 'cccc0000-0000-0000-0000-000000000002';
const ACCOUNT = 'dddd0000-0000-0000-0000-000000000003';

function collectSchedule() {
  const tasks: Array<() => Promise<unknown>> = [];
  return { tasks, schedule: (t: () => Promise<unknown>) => { tasks.push(t); } };
}

const stubDecider = (over: Partial<MemoryDecider> = {}): MemoryDecider => ({
  judgeLearn: async () => { throw new Error('unused'); },
  judgeUpdate: async () => { throw new Error('unused'); },
  labelUses: async () => [],
  shadowRelevance: async () => {},
  judgeChatDirective: async () => null,
  ...over,
});

describe('decisionUsageRow', () => {
  it('is an ai_usage decision receipt: no plan, no tier, metadata only', () => {
    const row = decisionUsageRow({
      kind: 'decision', decisionId: 'buildd.memory_learn', provider: 'openrouter', model: 'typesafe/jev-1.13-x',
      usage: { inputTokens: 300, outputTokens: 2, costUsd: 0.00002 }, latencyMs: 412.6, outcome: 'ok', attempts: 1,
    }, { teamId: TEAM, accountId: ACCOUNT });
    expect(row).toMatchObject({
      teamId: TEAM, accountId: ACCOUNT, planId: null, tier: null, surface: 'decision', kind: 'buildd.memory_learn',
      provider: 'openrouter', costUsd: '0.000020', costSource: 'reported', latencyMs: 413, outcome: 'ok',
    });
    const unpriced = decisionUsageRow({
      kind: 'decision', decisionId: null, provider: 'openrouter', model: 'm', usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
      latencyMs: 1, outcome: 'error', attempts: 1,
    }, { teamId: TEAM, accountId: ACCOUNT });
    expect(unpriced).toMatchObject({ costUsd: '0.000000', costSource: 'estimated' });
    // No acting account: attributed to the team alone.
    const teamOnly = decisionUsageRow({
      kind: 'decision', decisionId: 'buildd.memory_relevance', provider: 'openrouter', model: 'm', usage: { inputTokens: 1, outputTokens: 0, costUsd: 0 },
      latencyMs: 1, outcome: 'ok', attempts: 1,
    }, { teamId: TEAM, accountId: null });
    expect(teamOnly).toMatchObject({ teamId: TEAM, accountId: null });
  });
});

describe('scheduleAfter', () => {
  it('falls back to fire-and-forget outside a request scope', async () => {
    let ran = false;
    scheduleAfter(async () => { ran = true; }, () => { throw new Error('outside request'); });
    await Promise.resolve();
    expect(ran).toBe(true);
  });
});

describe('defaults are inert under test', () => {
  it('resolves no key, so nothing is spent or written', async () => {
    const deps = webMemoryDecisionDeps({ accountId: ACCOUNT });
    expect(await deps.resolveKey({ teamId: TEAM })).toBeNull();
    expect(() => deps.record([], [], { teamId: TEAM })).not.toThrow();
  });
});

const SHADOW_INPUT = { teamId: TEAM, workspaceId: WS, taskId: TASK, caller: 'claim_context' as const, query: 'fix it', hits: [{ memoryId: 'm1', rank: 1, score: 0.8, gatedBy: null, content: 'body' }] };

function shadowHarness(over: Record<string, unknown> = {}) {
  const { tasks, schedule } = collectSchedule();
  const calls: any[] = [];
  const hook = createRelevanceShadow({
    deciderFor: () => stubDecider({ shadowRelevance: async (i) => { calls.push(i); } }),
    loadWorkspace: async () => ({ dataClass: 'standard', gitConfig: null }),
    taskInWorkspace: async () => true,
    sampleRate: () => 1,
    random: () => 0,
    disabled: () => false,
    ...over,
  } as any, schedule);
  return { hook, tasks, calls };
}

describe('createRelevanceShadow', () => {
  it('returns at once and runs the verdicts in one scheduled task', async () => {
    const { hook, tasks, calls } = shadowHarness();
    hook(SHADOW_INPUT);
    expect(calls).toHaveLength(0);
    expect(tasks).toHaveLength(1);
    await tasks[0]();
    expect(calls[0]).toEqual({
      scope: { teamId: TEAM, workspaceId: WS, taskId: TASK },
      task: 'fix it',
      caller: 'claim_context',
      hits: [{ memoryId: 'm1', content: 'body', gatedBy: null }],
    });
  });

  it('refuses a sensitive workspace, by either marker, and a missing one', async () => {
    for (const ws of [{ dataClass: 'sensitive' }, { dataClass: 'standard', gitConfig: { dataClass: 'sensitive' } }, null]) {
      const { hook, tasks, calls } = shadowHarness({ loadWorkspace: async () => ws });
      hook(SHADOW_INPUT);
      await tasks[0]();
      expect(calls).toHaveLength(0);
    }
    const { hook, tasks, calls } = shadowHarness();
    hook({ ...SHADOW_INPUT, workspaceId: null });
    await tasks[0]();
    expect(calls).toHaveLength(0);
  });

  it('logs nothing for a task that fails the ledger attribution check', async () => {
    const { hook, tasks, calls } = shadowHarness({ taskInWorkspace: async () => false });
    hook(SHADOW_INPUT);
    await tasks[0]();
    expect(calls).toHaveLength(0);
  });

  it('samples, and the kill switch stops it before anything is scheduled', () => {
    const sampled = shadowHarness({ sampleRate: () => 0.25, random: () => 0.5 });
    sampled.hook(SHADOW_INPUT);
    expect(sampled.tasks).toHaveLength(0);
    const off = shadowHarness({ disabled: () => true });
    off.hook(SHADOW_INPUT);
    expect(off.tasks).toHaveLength(0);
  });
});

function judgeHarness(over: Record<string, unknown> = {}) {
  const calls: any[] = [];
  const judge = createRelevanceJudge({
    liveDecider: () => stubDecider({
      judgeRelevance: async (i) => { calls.push(i); return { demote: new Set(['m1']), record: () => {} }; },
    }),
    loadWorkspace: async () => ({ dataClass: 'standard', gitConfig: null }),
    taskInWorkspace: async () => true,
    disabled: () => false,
    liveEnabled: () => true,
    ...over,
  } as any);
  return { judge, calls };
}

describe('createRelevanceJudge', () => {
  it('asks the decider inside the budget, with the mandatory flag and the scope', async () => {
    const { judge, calls } = judgeHarness();
    const v = await judge({ ...SHADOW_INPUT, budgetMs: 1_000, hits: [{ ...SHADOW_INPUT.hits[0], mandatory: true }] });
    expect([...(v?.demote ?? [])]).toEqual(['m1']);
    expect(calls[0]).toMatchObject({
      scope: { teamId: TEAM, workspaceId: WS, taskId: TASK },
      task: 'fix it',
      caller: 'claim_context',
      hits: [{ memoryId: 'm1', content: 'body', gatedBy: null, mandatory: true }],
    });
    expect(calls[0].budgetMs).toBeGreaterThan(0);
    expect(calls[0].budgetMs).toBeLessThanOrEqual(1_000);
  });

  it('null (rule order and the shadow) when live is off, decisions are disabled, or the workspace/task does not check out', async () => {
    for (const over of [
      { liveEnabled: () => false },
      { disabled: () => true },
      { loadWorkspace: async () => ({ dataClass: 'sensitive' }) },
      { taskInWorkspace: async () => false },
      { loadWorkspace: async () => { throw new Error('db'); } },
    ]) {
      const { judge, calls } = judgeHarness(over);
      expect(await judge({ ...SHADOW_INPUT, budgetMs: 1_000 })).toBeNull();
      expect(calls).toHaveLength(0);
    }
  });

  it('a decider without judgeRelevance (an older fake) judges nothing', async () => {
    const { judge } = judgeHarness({ liveDecider: () => stubDecider() });
    expect(await judge({ ...SHADOW_INPUT, budgetMs: 1_000 })).toBeNull();
  });
});

describe('config', () => {
  it('relevance live is on by default; MEMORY_RELEVANCE_LIVE=0 returns to shadow only', () => {
    expect(memoryRelevanceLiveEnabled({})).toBe(true);
    expect(memoryRelevanceLiveEnabled({ MEMORY_RELEVANCE_LIVE: '0' })).toBe(false);
    expect(memoryRelevanceLiveEnabled({ MEMORY_RELEVANCE_LIVE: 'off' })).toBe(false);
    expect(memoryRelevanceLiveEnabled({ MEMORY_RELEVANCE_LIVE: '1' })).toBe(true);
  });

  it('sample rate defaults to 0.25 and is clamped; the kill switch reads truthy values', () => {
    expect(relevanceShadowSampleRate({})).toBe(0.25);
    expect(relevanceShadowSampleRate({ MEMORY_RELEVANCE_SHADOW_SAMPLE: '0.5' })).toBe(0.5);
    expect(relevanceShadowSampleRate({ MEMORY_RELEVANCE_SHADOW_SAMPLE: '7' })).toBe(1);
    expect(relevanceShadowSampleRate({ MEMORY_RELEVANCE_SHADOW_SAMPLE: 'nope' })).toBe(0.25);
    expect(memoryDecisionsDisabled({ MEMORY_DECISIONS_DISABLED: '1' })).toBe(true);
    expect(memoryDecisionsDisabled({})).toBe(false);
  });
});

describe('shouldLabelMemoryUses (the worker route gate)', () => {
  const base = { status: 'completed', previousStatus: 'running', taskId: TASK, workspace: { dataClass: 'standard', gitConfig: null }, serverRefusal: false };
  it('labels on the transition into completed for a standard workspace', () => {
    expect(shouldLabelMemoryUses(base)).toBe(true);
  });
  it('skips sensitive (either marker), a missing workspace, repeats, refusals and other statuses', () => {
    expect(shouldLabelMemoryUses({ ...base, workspace: { dataClass: 'sensitive' } })).toBe(false);
    expect(shouldLabelMemoryUses({ ...base, workspace: { dataClass: 'standard', gitConfig: { dataClass: 'sensitive' } } })).toBe(false);
    expect(shouldLabelMemoryUses({ ...base, workspace: null })).toBe(false);
    expect(shouldLabelMemoryUses({ ...base, previousStatus: 'completed' })).toBe(false);
    expect(shouldLabelMemoryUses({ ...base, serverRefusal: true })).toBe(false);
    expect(shouldLabelMemoryUses({ ...base, status: 'failed' })).toBe(false);
    expect(shouldLabelMemoryUses({ ...base, taskId: null })).toBe(false);
  });
});

describe('scheduleMemoryUseLabels', () => {
  it('labels after the response with injected deps', async () => {
    const { tasks, schedule } = collectSchedule();
    const writes: any[] = [];
    scheduleMemoryUseLabels({ taskId: TASK, accountId: ACCOUNT, summary: 'did it' }, {
      schedule,
      deps: {
        decider: stubDecider({ labelUses: async ({ memories }) => memories.map(m => ({ memoryId: m.memoryId, outcome: 'used' as const })) }),
        loadUses: async () => [{ teamId: TEAM, workspaceId: WS, memoryId: 'm1' }],
        loadMemories: async () => [{ id: 'm1', content: 'c' }],
        writeOutcomes: async (taskId, labels) => { writes.push({ taskId, labels }); },
      },
    });
    expect(writes).toHaveLength(0);
    await tasks[0]();
    expect(writes).toEqual([{ taskId: TASK, labels: [{ memoryId: 'm1', outcome: 'used' }] }]);
  });

  it('does nothing without a summary or a task id, and nothing by default under test', () => {
    const { tasks, schedule } = collectSchedule();
    scheduleMemoryUseLabels({ taskId: TASK, summary: '' }, { schedule });
    scheduleMemoryUseLabels({ taskId: 'not-a-uuid', summary: 'x' }, { schedule });
    scheduleMemoryUseLabels({ taskId: TASK, summary: 'x' }, { schedule });
    expect(tasks).toHaveLength(0);
  });
});
