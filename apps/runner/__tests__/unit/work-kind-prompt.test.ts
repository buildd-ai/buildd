import { describe, expect, test } from 'bun:test';
import { buildPromptWithComposition } from '../../src/prompt-builder';

/**
 * Worker self-classification (docs/specs/mission-legibility.md Rule K2-17).
 *
 * The ask is conditional on purpose. `kind` is written at most once, so a task
 * that already has one has nothing to learn from the worker — and telling every
 * agent to report a field that will be discarded spends prompt budget to
 * produce a guaranteed no-op.
 */
function ctx(taskOverrides: Record<string, unknown> = {}) {
  return {
    task: {
      id: '510c4619-e02e-47bb-a018-e6336d1ff989',
      title: 'Wire the glyph column',
      description: 'Draw the work-kind glyph on the rail.',
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

describe('work-kind prompt', () => {
  test('asks for a kind when the task has none', () => {
    const built = buildPromptWithComposition(ctx());
    expect(built.promptText).toContain('## Work Kind');
    expect(built.promptText).toContain('no recorded work-kind');
    // Names the call that actually records it, and the closed vocabulary.
    expect(built.promptText).toContain('update_progress');
    for (const k of ['coordination', 'engineering', 'research', 'writing', 'design', 'analysis', 'observation']) {
      expect(built.promptText).toContain(k);
    }
  });

  test('says nothing when the task already carries a kind', () => {
    const built = buildPromptWithComposition(ctx({ kind: 'engineering' }));
    expect(built.promptText).not.toContain('## Work Kind');
    expect(built.promptText).not.toContain('no recorded work-kind');
  });

  test('the section is additive — the task block is unchanged either way', () => {
    const withKind = buildPromptWithComposition(ctx({ kind: 'research' })).promptText;
    const without = buildPromptWithComposition(ctx()).promptText;
    expect(withKind).toContain('## Task\nDraw the work-kind glyph on the rail.');
    expect(without).toContain('## Task\nDraw the work-kind glyph on the rail.');
  });
});
