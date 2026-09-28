import { describe, expect, it } from 'bun:test';
import {
  createRelevanceShadow,
  decisionUsageRow,
  scheduleAfter,
  scheduleMemoryUseLabels,
  webMemoryDecisionDeps,
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

describe('createRelevanceShadow', () => {
  it('returns at once and runs the verdicts in one scheduled task', async () => {
    const { tasks, schedule } = collectSchedule();
    const calls: any[] = [];
    const hook = createRelevanceShadow(() => stubDecider({ shadowRelevance: async (i) => { calls.push(i); } }), schedule);
    hook({ teamId: TEAM, workspaceId: WS, taskId: TASK, caller: 'claim_context', query: 'fix it', hits: [{ memoryId: 'm1', rank: 1, score: 0.8, gatedBy: null, content: 'body' }] });
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
