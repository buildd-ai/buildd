import { describe, expect, test } from 'bun:test';
import { buildPromptWithComposition } from '../../src/prompt-builder';

function ctx(taskOverrides: Record<string, unknown> = {}) {
  return {
    task: {
      id: '510c4619-e02e-47bb-a018-e6336d1ff989',
      title: 'Plan the mission',
      description: 'Plan it.',
      workspaceId: 'ws-1',
      status: 'assigned',
      priority: 0,
      mode: 'planning',
      ...taskOverrides,
    },
    worker: { id: 'worker-1', workspaceName: 'demo' },
    isConfigured: false,
    compactResult: { count: 0 },
    taskSearchResults: [],
    fullObservations: [],
    inputPolicy: 'autonomous',
    hasApiKey: true,
  } as any;
}

describe('planning prompt: what shipped', () => {
  test('a mission planning task is told to fill `shipped` when it sets missionComplete', () => {
    const { promptText } = buildPromptWithComposition(ctx());
    expect(promptText).toContain('When you set missionComplete, also fill `shipped`.');
    expect(promptText).toContain('`shipped.lede`');
    expect(promptText).toContain('`shipped.offPlan`');
  });

  test('an evaluator gets its instruction from the evaluation prompt, not this one', () => {
    const { promptText } = buildPromptWithComposition(ctx({ context: { evaluator: true } }));
    expect(promptText).not.toContain('also fill `shipped`');
  });

  test('a heartbeat does not author a report', () => {
    const { promptText } = buildPromptWithComposition(ctx({ context: { heartbeat: true } }));
    expect(promptText).not.toContain('also fill `shipped`');
  });

  test('an execution task is unchanged', () => {
    const { promptText } = buildPromptWithComposition(ctx({ mode: 'execution', outputRequirement: 'pr_required' }));
    expect(promptText).not.toContain('`shipped.lede`');
  });
});
