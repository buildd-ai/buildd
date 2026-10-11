import { describe, expect, it } from 'bun:test';
import { fetchFileAtCommit, MAX_REPO_REF_FILE_BYTES } from './repo-source';

const SHA = 'b'.repeat(40);
const repo = { fullName: 'acme/shop', installationId: 7 };
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const notFound = () => { throw new Error('GitHub API error: 404 Not Found'); };

describe('fetchFileAtCommit', () => {
  it('checks the commit, then reads the file at that SHA (never a branch)', async () => {
    const calls: string[] = [];
    const r = await fetchFileAtCommit(repo, 'docs/specs/checkout.md', SHA, async (_id, path) => {
      calls.push(path);
      return path.includes('/git/commits/') ? { sha: SHA } : { type: 'file', size: 5, encoding: 'base64', content: b64('hello') };
    });
    expect(r).toEqual({ ok: true, text: 'hello' });
    expect(calls).toEqual([`/repos/acme/shop/git/commits/${SHA}`, `/repos/acme/shop/contents/docs/specs/checkout.md?ref=${SHA}`]);
  });

  it('a commit that is not in the repo is not_found', async () => {
    const r = await fetchFileAtCommit(repo, 'docs/a.md', SHA, async () => { throw new Error('GitHub API error: 422 No commit found'); });
    expect(r.ok === false && r.reason).toBe('not_found');
  });

  it('a path missing at that commit is not_found, a directory is not_a_file, a huge file too_large', async () => {
    const at = (contents: () => unknown) => async (_id: number, path: string) => (path.includes('/git/commits/') ? { sha: SHA } : contents());
    expect(await fetchFileAtCommit(repo, 'docs/nope.md', SHA, at(notFound))).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await fetchFileAtCommit(repo, 'docs', SHA, at(() => [{ name: 'a.md' }]))).toMatchObject({ ok: false, reason: 'not_a_file' });
    expect(await fetchFileAtCommit(repo, 'docs/big.md', SHA, at(() => ({ type: 'file', size: MAX_REPO_REF_FILE_BYTES + 1, encoding: 'none', content: '' })))).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('GitHub being down is unavailable, not not_found', async () => {
    const r = await fetchFileAtCommit(repo, 'docs/a.md', SHA, async () => { throw new Error('GitHub API error: 503 Service Unavailable'); });
    expect(r.ok === false && r.reason).toBe('unavailable');
  });
});
