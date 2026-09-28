import { describe, it, expect } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const ctx: ActionContext = { authType: 'oauth', getWorkspaceId: async () => null, getLevel: async () => 'worker' };

const body = (checks: Record<string, unknown>) => ({
  pr: { number: 7, title: 'T', state: 'open', mergeable: true, mergeableState: 'clean', additions: 1, deletions: 1, changedFiles: 1, generatedFiles: 0, url: 'https://github.com/o/r/pull/7', body: null },
  checks: { total: 2, passed: 1, failed: 1, pending: 0, state: 'failure', ...checks },
  reviews: { approved: 0, changesRequested: 0, pending: 0 },
});

async function text(checks: Record<string, unknown>) {
  const r = await handleBuilddAction((async () => body(checks)) as unknown as ApiFn, 'get_pr', { prNumber: 7 }, ctx);
  return r.content[0].text as string;
}

describe('get_pr names the failing checks', () => {
  it('lists them with their links under the CI line', async () => {
    const out = await text({ failedChecks: [{ name: 'build', conclusion: 'failure', url: 'https://gh/runs/1' }] });
    expect(out).toContain('CI: failure (1/2 passed, 1 failed)\nFailing: build (https://gh/runs/1)');
  });

  it('says nothing extra when none are failing, or an older server sends none', async () => {
    expect(await text({ failedChecks: [] })).not.toContain('Failing:');
    expect(await text({})).not.toContain('Failing:');
  });
});
