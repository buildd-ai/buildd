import { describe, expect, test } from 'bun:test';
import { buildPromptWithComposition } from '../../src/prompt-builder';

/**
 * A planning task whose plan is a PROPOSAL SLOT rather than its deliverable.
 *
 * The doc-fix dispatch is the first of these: its output is a docs-only PR,
 * and the optional `plan` is where a net-enhancement proposal lands so the
 * existing approve_plan / reject_plan gate can adjudicate it. The standard
 * planning block is exactly wrong for that shape — it suppresses the PR
 * requirement and tells the agent an empty plan stalls a mission, when here an
 * empty plan is the expected, correct outcome.
 */
function ctx(taskOverrides: Record<string, unknown> = {}) {
  return {
    task: {
      id: '510c4619-e02e-47bb-a018-e6336d1ff989',
      title: 'Reconcile spec with shipped code: docs/design/x.md',
      description: 'Reconcile the doc.',
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

const optionalPlanTask = {
  mode: 'planning',
  outputRequirement: 'pr_required',
  context: { planOptional: true },
};

describe('planning task with an optional plan', () => {
  test('still announces the real deliverable — the PR — instead of the planning block', () => {
    const built = buildPromptWithComposition(ctx(optionalPlanTask));
    expect(built.promptText).toContain('requires a PR');
    expect(built.promptText).toContain('create_pr');
    expect(built.promptText).not.toContain('This is a **planning task**');
  });

  test('says an empty plan is a valid outcome, not a stall', () => {
    const built = buildPromptWithComposition(ctx(optionalPlanTask));
    expect(built.promptText).toContain('## Optional Plan');
    expect(built.promptText).toMatch(/returning no plan is a valid, expected outcome/);
    // The mission-cycle rule must NOT leak into this shape.
    expect(built.promptText).not.toContain('stalls the mission');
  });

  test('states that nothing in the plan dispatches itself', () => {
    const built = buildPromptWithComposition(ctx(optionalPlanTask));
    expect(built.promptText).toMatch(/Nothing in the plan is dispatched automatically/);
    expect(built.promptText).toContain('Do NOT call create_task');
  });

  test('an ordinary planning task is unchanged — the mission planning block still renders', () => {
    const built = buildPromptWithComposition(ctx({ mode: 'planning' }));
    expect(built.promptText).toContain('This is a **planning task**');
    expect(built.promptText).toContain('stalls the mission');
    expect(built.promptText).not.toContain('## Optional Plan');
  });

  test('an ordinary execution task renders no plan section at all', () => {
    const built = buildPromptWithComposition(ctx({ outputRequirement: 'pr_required' }));
    expect(built.promptText).not.toContain('## Optional Plan');
    expect(built.promptText).not.toContain('This is a **planning task**');
  });
});
