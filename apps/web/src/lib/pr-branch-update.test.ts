import { describe, it, expect } from 'bun:test';
import { updateBehindPrBranch } from './pr-branch-update';

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
