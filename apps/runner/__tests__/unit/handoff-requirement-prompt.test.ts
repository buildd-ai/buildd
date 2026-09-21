import { describe, expect, test } from 'bun:test';
import { buildPromptWithComposition } from '../../src/prompt-builder';

/**
 * Claim-time handoff announcement (mission-task-handoff). The claim route
 * writes `task.context.dependentCount` when other tasks depend on this one;
 * the prompt must surface that up front rather than let the worker discover
 * the requirement only when `PATCH /api/workers/[id]` rejects completion.
 */
function ctx(taskOverrides: Record<string, unknown> = {}) {
  return {
    task: {
      id: '510c4619-e02e-47bb-a018-e6336d1ff989',
      title: 'Implement the shared client',
      description: 'Build the client other tasks will import.',
      workspaceId: 'ws-1',
      status: 'assigned',
      priority: 0,
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

describe('handoff requirement prompt', () => {
  test('announces the requirement when the task has real dependents', () => {
    const built = buildPromptWithComposition(ctx({ context: { dependentCount: 2 } }));
    expect(built.promptText).toContain('## Handoff Requirement');
    expect(built.promptText).toContain('2 task(s) depend on this one');
    expect(built.promptText).toContain('handoff');
    expect(built.promptText).toContain('delivered');
  });

  test('says nothing when the task has no dependents', () => {
    const built = buildPromptWithComposition(ctx());
    expect(built.promptText).not.toContain('## Handoff Requirement');
  });

  test('says nothing when dependentCount is explicitly zero', () => {
    const built = buildPromptWithComposition(ctx({ context: { dependentCount: 0 } }));
    expect(built.promptText).not.toContain('## Handoff Requirement');
  });
});
