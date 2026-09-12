import { describe, expect, test } from 'bun:test';
import { buildPromptWithComposition } from '../../src/prompt-builder';

/**
 * The 'auto' output requirement (the default) used to render no dispatch-time
 * section at all — the agent only learned it had to open a PR/artifact/discard
 * its edits when complete_task hard-refused on its LAST call, after the work
 * was already spent. This asserts the obligation is now announced in the
 * prompt actually built for dispatch, not merely present in source.
 */
function ctx(taskOverrides: Record<string, unknown> = {}) {
  return {
    task: {
      id: '510c4619-e02e-47bb-a018-e6336d1ff989',
      title: 'Coordinate sibling PRs and dispatch a release',
      description: 'Coordinate sibling PRs and dispatch a release',
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

describe('auto-mode dispatch obligation', () => {
  test('an unset outputRequirement announces the create_pr/artifact/discardEdits obligation', () => {
    const built = buildPromptWithComposition(ctx());
    expect(built.promptText).toContain('## Output Requirement');
    expect(built.promptText).toContain('create_pr');
    expect(built.promptText).toContain('discardEdits');
  });

  test('an explicit outputRequirement of auto renders the same obligation', () => {
    const built = buildPromptWithComposition(ctx({ outputRequirement: 'auto' }));
    expect(built.promptText).toContain('discardEdits');
  });

  test('the obligation notes a cross-branch deliverable (merge_pr) satisfies it without a PR of its own', () => {
    const built = buildPromptWithComposition(ctx());
    expect(built.promptText).toContain('merge_pr');
  });

  test('pr_required still renders its own section, not the auto obligation', () => {
    const built = buildPromptWithComposition(ctx({ outputRequirement: 'pr_required' }));
    expect(built.promptText).toContain('requires a PR');
    expect(built.promptText).not.toContain('discardEdits');
  });

  test('none still renders its own section, not the auto obligation', () => {
    const built = buildPromptWithComposition(ctx({ outputRequirement: 'none' }));
    expect(built.promptText).toContain('no output requirement');
    expect(built.promptText).not.toContain('discardEdits');
  });
});
