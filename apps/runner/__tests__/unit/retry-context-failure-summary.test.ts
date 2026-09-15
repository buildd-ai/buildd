import { describe, expect, test } from 'bun:test';
import { buildPromptWithComposition } from '../../src/prompt-builder';

/**
 * `task.context.failureContext` is written as the structured
 * `{ summary, errorType?, commitSha? }` object by every canonical writer
 * (ci-retry.ts, conflict-retry.ts, loop-dispatcher.ts, the direct
 * failure-capture path in workers/[id]/route.ts) — the bare-string form only
 * exists for backward compat with tasks written before that shape landed.
 * The "## Retry Context" section must render the human summary either way,
 * not `String(failureContext)`, which stringifies an object to "[object
 * Object]".
 */
function ctx(taskOverrides: Record<string, unknown> = {}) {
  return {
    task: {
      id: '510c4619-e02e-47bb-a018-e6336d1ff989',
      title: 'Fix the flaky login test',
      description: 'Make the login test deterministic.',
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

describe('Retry Context failure summary rendering', () => {
  test('renders the summary from the structured object form, not "[object Object]"', () => {
    const built = buildPromptWithComposition(ctx({
      context: {
        iteration: 2,
        maxIterations: 3,
        baseBranch: 'buildd/abc-fix-login',
        failureContext: {
          summary: 'CI failed: login.test.ts timed out waiting for redirect',
          errorType: 'ci_failure',
          commitSha: 'deadbeef',
        },
      },
    }));
    expect(built.promptText).toContain(
      'Previous failure: CI failed: login.test.ts timed out waiting for redirect',
    );
    expect(built.promptText).not.toContain('[object Object]');
  });

  test('still renders a bare-string failureContext (backward compat)', () => {
    const built = buildPromptWithComposition(ctx({
      context: {
        iteration: 1,
        maxIterations: 3,
        baseBranch: 'buildd/abc-fix-login',
        failureContext: 'Legacy plain-string failure summary',
      },
    }));
    expect(built.promptText).toContain('Previous failure: Legacy plain-string failure summary');
  });
});
