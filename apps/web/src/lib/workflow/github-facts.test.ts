/**
 * The kernel's live GitHub reads: only GitHub's own answer is a fact; an
 * unreadable answer is unknown, never the convenient value.
 */
import { describe, expect, test } from 'bun:test';
import { githubReader, readBaseDelta } from './github-facts';

describe('branchExists (close cause, §4)', () => {
  const reader = (answer: () => unknown) => githubReader(1, (async () => answer()) as never);

  test('a branch GitHub returns exists; a 404 is deleted; any other failure is unknown', async () => {
    const asked: string[] = [];
    const ok = githubReader(1, (async (_i: number, path: string) => { asked.push(path); return { name: 'mission/x' }; }) as never);
    expect(await ok.branchExists!('acme/widgets', 'mission/x')).toBe(true);
    expect(asked).toEqual(['/repos/acme/widgets/branches/mission/x']);
    expect(await reader(() => { throw new Error('GitHub API error: 404 {"message":"Branch not found"}'); }).branchExists!('acme/widgets', 'gone')).toBe(false);
    expect(await reader(() => { throw new Error('GitHub API error: 502 Bad Gateway'); }).branchExists!('acme/widgets', 'x')).toBeNull();
    expect(await reader(() => null).branchExists!('acme/widgets', 'x')).toBeNull();
  });
});

describe('readBaseDelta (S15 base delta)', () => {
  const files = (n: number, prefix = 'f') => Array.from({ length: n }, (_, i) => ({ filename: `${prefix}${i}.ts` }));

  test('the commits and files the base gained since the head, and the PR\'s own files', async () => {
    const paths: string[] = [];
    const get = async (path: string) => {
      paths.push(path);
      if (path.includes('/compare/')) return { ahead_by: 4, files: [{ filename: 'src/x.ts' }] };
      return [{ filename: 'src/a.ts' }];
    };
    expect(await readBaseDelta(get, 'acme/w', 7, 'H1', 'dev')).toEqual({ baseCommits: 4, baseFiles: ['src/x.ts'], prFiles: ['src/a.ts'] });
    expect(paths[0]).toBe('/repos/acme/w/compare/H1...dev');
  });

  test('a list that may be cut, or a read that fails, is null on that side (never "nothing changed")', async () => {
    const capped = async (path: string) => (path.includes('/compare/') ? { ahead_by: 400, files: files(300) } : files(100));
    expect(await readBaseDelta(capped, 'acme/w', 7, 'H1', 'dev')).toEqual({ baseCommits: 400, baseFiles: null, prFiles: null });
    const failing = async () => { throw new Error('502'); };
    expect(await readBaseDelta(failing, 'acme/w', 7, 'H1', 'dev')).toEqual({ baseCommits: null, baseFiles: null, prFiles: null });
    // Pages until a short one.
    const paged = async (path: string) => (path.includes('/compare/') ? { ahead_by: 1, files: [] } : path.endsWith('page=1') ? files(100) : files(5, 'g'));
    expect((await readBaseDelta(paged, 'acme/w', 7, 'H1', 'dev')).prFiles).toHaveLength(105);
  });
});

// D12 / AC-15: a merge no buildd door made records who made it, as GitHub reports it.
describe('toLivePr: the merger', () => {
  test('a merged PR carries merged_by; an open one carries nothing extra', async () => {
    const { toLivePr } = await import('./github-facts');
    const merged = toLivePr({ state: 'closed', merged: true, merged_at: '2026-10-01T00:00:00Z', merge_commit_sha: 'm1', merged_by: { login: 'a-person' }, head: { sha: 'h1' }, base: { ref: 'dev' } } as never);
    expect(merged?.mergedBy).toBe('a-person');
    const open = toLivePr({ state: 'open', merged: false, head: { sha: 'h1' }, base: { ref: 'dev' } } as never);
    expect(open && 'mergedBy' in open).toBe(false);
  });
});
