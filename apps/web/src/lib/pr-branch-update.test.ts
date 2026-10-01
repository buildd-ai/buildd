import { describe, it, expect } from 'bun:test';
import { updateBehindPrBranch, classifyBranchUpdateFailure } from './pr-branch-update';

describe('updateBehindPrBranch', () => {
  const BASE = { installationId: 1, repoFullName: 'acme/app', prNumber: 7, headSha: 'a'.repeat(40) };

  it('asks GitHub to merge the base in, pinned to the head it evaluated', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const api = async (_id: number, path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      return { message: 'Updating pull request branch.' };
    };
    expect(await updateBehindPrBranch({ ...BASE, api })).toEqual({ updated: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/repos/acme/app/pulls/7/update-branch');
    expect(calls[0].init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ expected_head_sha: BASE.headSha });
  });

  it('reports failure instead of throwing (conflict, moved head, missing permission)', async () => {
    const api = async () => {
      throw new Error('GitHub API error: 422 merge conflict between base and head');
    };
    const result = await updateBehindPrBranch({ ...BASE, api });
    expect(result.updated).toBe(false);
    expect(result.reason).toContain('422');
  });
});

describe('classifyBranchUpdateFailure — an API error alone is not conflict evidence', () => {
  it('only a 422 naming a merge conflict is a textual conflict', () => {
    expect(classifyBranchUpdateFailure('GitHub API error: 422 {"message":"merge conflict between base and head"}')).toBe('conflict');
    // Conflict wording without GitHub's 422 is not verified evidence.
    expect(classifyBranchUpdateFailure('merge conflict between base and head')).toBe('unknown');
  });

  it('a moved head is a re-read, not a conflict', () => {
    expect(classifyBranchUpdateFailure(`GitHub API error: 422 {"message":"expected head sha didn't match current head ref."}`)).toBe('head_changed');
  });

  it('separates rate limit, auth and transient failures', () => {
    expect(classifyBranchUpdateFailure('GitHub API error: 429 too many requests')).toBe('rate_limit');
    expect(classifyBranchUpdateFailure('GitHub API error: 403 {"message":"API rate limit exceeded for installation"}')).toBe('rate_limit');
    expect(classifyBranchUpdateFailure('GitHub API error: 403 {"message":"secondary rate limit"}')).toBe('rate_limit');
    expect(classifyBranchUpdateFailure('GitHub API error: 403 {"message":"Resource not accessible by integration"}')).toBe('auth');
    expect(classifyBranchUpdateFailure('GitHub API error: 401 Bad credentials')).toBe('auth');
    expect(classifyBranchUpdateFailure('Failed to get installation token: 401')).toBe('auth');
    expect(classifyBranchUpdateFailure('GitHub API error: 502 Bad Gateway')).toBe('transient');
    expect(classifyBranchUpdateFailure('fetch failed')).toBe('transient');
    expect(classifyBranchUpdateFailure('ECONNRESET')).toBe('transient');
    expect(classifyBranchUpdateFailure('The operation timed out.')).toBe('transient');
  });

  it('anything else is unknown, never conflict', () => {
    expect(classifyBranchUpdateFailure('GitHub API error: 422 {"message":"Validation Failed"}')).toBe('unknown');
    expect(classifyBranchUpdateFailure('GitHub API error: 404 Not Found')).toBe('unknown');
    expect(classifyBranchUpdateFailure('')).toBe('unknown');
  });

  it('updateBehindPrBranch carries the classification on a failure', async () => {
    const BASE = { installationId: 1, repoFullName: 'acme/app', prNumber: 7, headSha: 'a'.repeat(40) };
    const failWith = (msg: string) => async () => { throw new Error(msg); };
    expect((await updateBehindPrBranch({ ...BASE, api: failWith('GitHub API error: 422 merge conflict between base and head') })).failure).toBe('conflict');
    expect((await updateBehindPrBranch({ ...BASE, api: failWith('GitHub API error: 503 unavailable') })).failure).toBe('transient');
    expect((await updateBehindPrBranch({ ...BASE, api: failWith(`GitHub API error: 422 expected head sha didn't match current head ref`) })).failure).toBe('head_changed');
  });
});
