/**
 * get_pr lists the fix attempts on the PR's chain with each attempt's
 * errorClass, first key line and mismatch flags, and stays silent when there
 * are none.
 */

import { describe, expect, it } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

const ctx: ActionContext = { workerId: 'worker-1', getWorkspaceId: async () => 'workspace-1', getLevel: async () => 'worker' };

const BASE = {
  ok: true,
  pr: {
    number: 7, title: 'A PR', body: null, state: 'open', url: 'https://github.com/o/r/pull/7',
    mergeable: true, mergeableState: 'clean', headSha: 's', baseRef: 'dev',
    additions: null, deletions: null, changedFiles: null, generatedAdditions: 0, generatedDeletions: 0, generatedFiles: 0,
  },
  checks: { total: 0, passed: 0, failed: 0, pending: 0, state: 'none', failedChecks: [] },
  reviews: { approved: 0, changesRequested: 0, pending: 0 },
};

async function run(extra: Record<string, unknown>) {
  const api = (async () => ({ ...BASE, ...extra })) as unknown as ApiFn;
  const out = await handleBuilddAction(api, 'get_pr', { prNumber: 7 }, ctx);
  return (out as { content: Array<{ text: string }> }).content[0]!.text;
}

describe('get_pr fix attempts', () => {
  it('lists each attempt with its errorClass, first key line, PR and mismatch', async () => {
    const text = await run({
      attempts: [
        { taskId: 'aaaaaaaa-1111', title: 'Fix CI on #7 (after CI #1)', status: 'failed', prNumber: 7,
          evidence: { errorClass: 'type_error', keyLines: ['src/a.ts(3,1): error TS2322', 'second'] }, mismatch: [] },
        { taskId: 'bbbbbbbb-2222', title: 'Fix CI on #7 (after CI #2)', status: 'completed', prNumber: 9,
          evidence: { errorClass: 'test_failure', keyLines: ['(fail) x'] },
          mismatch: [{ kind: 'success_with_red_check', detail: 'unit is red' }] },
      ],
    });
    expect(text).toContain('Fix attempts (2)');
    expect(text).toContain('aaaaaaaa failed PR #7');
    expect(text).toContain('type_error: src/a.ts(3,1): error TS2322');
    expect(text).not.toContain('second');
    expect(text).toContain('bbbbbbbb completed PR #9');
    expect(text).toContain('success_with_red_check');
  });

  it('renders nothing when there are no attempts', async () => {
    expect(await run({})).not.toContain('Fix attempts');
    expect(await run({ attempts: [] })).not.toContain('Fix attempts');
  });
});
