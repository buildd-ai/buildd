import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { composeBodyWithLede, extractLede } from '@buildd/core/pr-lede';

interface GithubCall { path: string; method: string; body: any }

let calls: GithubCall[] = [];
let prBody: string | null = null;
let failOn: 'none' | 'read' | 'write' = 'none';

const mockGithubApi = mock(async (_installationId: number, path: string, init?: any) => {
  const method = init?.method ?? 'GET';
  calls.push({ path, method, body: init?.body ? JSON.parse(init.body) : null });
  if (method === 'GET') {
    if (failOn === 'read') throw new Error('502 from GitHub');
    return { body: prBody };
  }
  if (failOn === 'write') throw new Error('422 body could not be updated');
  return {};
});

mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));

const mockAppendPrActivity = mock(async () => ({ action: 'updated' as const, commentId: 1 }));
mock.module('@/lib/pr-activity-comment', () => ({ appendPrActivity: mockAppendPrActivity }));

const { applyReviewerLedeCorrection } = await import('./pr-lede-correction');

const AUTHORED = 'This change deletes the retry loop.';
const CORRECTED = 'This change adds a retry loop; it does not delete one.';

function params(correctedLede?: string | null) {
  return {
    installationId: 5000,
    repoFullName: 'org/repo',
    prNumber: 42,
    correctedLede,
    workspaceId: 'ws-1',
  };
}

describe('applyReviewerLedeCorrection', () => {
  beforeEach(() => {
    calls = [];
    failOn = 'none';
    prBody = composeBodyWithLede(AUTHORED, '## Detail\n\nwhat actually happened');
    mockAppendPrActivity.mockClear();
  });

  it('the common case — no correction proposed — touches GitHub not at all', async () => {
    const result = await applyReviewerLedeCorrection(params(undefined));

    expect(result).toEqual({ applied: false, reason: 'no correction proposed' });
    expect(calls).toHaveLength(0);
    expect(mockAppendPrActivity).not.toHaveBeenCalled();
  });

  it('treats a blank correction as no correction', async () => {
    const result = await applyReviewerLedeCorrection(params('   '));
    expect(result.applied).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('applies the correction, preserving the author’s original in the body', async () => {
    const result = await applyReviewerLedeCorrection(params(CORRECTED));

    expect(result).toEqual({ applied: true, original: AUTHORED, corrected: CORRECTED });

    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.path).toBe('/repos/org/repo/pulls/42');
    expect(extractLede(patch.body.body)?.lede).toBe(CORRECTED);
    // Never a silent overwrite: the author's own sentence stays readable, and
    // the rest of their account is untouched.
    expect(patch.body.body).toContain(AUTHORED);
    expect(patch.body.body).toContain('corrected by the buildd reviewer');
    expect(patch.body.body).toContain('## Detail\n\nwhat actually happened');
  });

  it('records the substitution on the PR activity comment so it is auditable', async () => {
    await applyReviewerLedeCorrection(params(CORRECTED));

    expect(mockAppendPrActivity).toHaveBeenCalledTimes(1);
    const arg = mockAppendPrActivity.mock.calls[0][0] as any;
    expect(arg.entry.kind).toBe('lede_corrected');
    expect(arg.entry.detail).toContain(AUTHORED);
  });

  it('leaves a PR with no lede block alone — nothing to replace, nothing to preserve', async () => {
    prBody = 'A body opened outside buildd, with no lede.';

    const result = await applyReviewerLedeCorrection(params(CORRECTED));

    expect(result).toEqual({ applied: false, reason: 'no lede block to correct' });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('is a no-op when the correction matches the lede already there', async () => {
    const result = await applyReviewerLedeCorrection(params(AUTHORED));
    expect(result.applied).toBe(false);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('never throws when the body edit fails — it resolves, so the verdict is unaffected', async () => {
    failOn = 'write';

    const result = await applyReviewerLedeCorrection(params(CORRECTED));

    expect(result.applied).toBe(false);
    expect((result as { reason: string }).reason).toContain('422');
  });

  it('never throws when the PR cannot even be read', async () => {
    failOn = 'read';

    const result = await applyReviewerLedeCorrection(params(CORRECTED));

    expect(result.applied).toBe(false);
    expect((result as { reason: string }).reason).toContain('502');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});
