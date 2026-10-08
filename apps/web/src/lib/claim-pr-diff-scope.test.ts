import { beforeEach, describe, expect, it } from 'bun:test';
import { prefetchPrDiffScopes, resetPrDiffScopeCache, type PrDiffScopeDeps } from './claim-pr-diff-scope';

type PrState = { head: string; base: string; files: string[] };

function deps(prs: Record<number, PrState>, calls: string[] = []): PrDiffScopeDeps {
  return {
    resolveRepo: async () => ({ fullName: 'o/r', installationId: 1 }),
    github: async (_i, path) => {
      calls.push(path);
      const m = path.match(/pulls\/(\d+)(\/files)?/);
      const pr = prs[Number(m![1])];
      if (!pr) throw new Error('404');
      if (m![2]) return pr.files.map(filename => ({ filename }));
      return { state: 'open', head: { sha: pr.head }, base: { sha: pr.base, ref: 'dev' }, changed_files: pr.files.length };
    },
    now: () => Date.parse('2026-10-08T12:00:00Z'),
  };
}

describe('prefetchPrDiffScopes', () => {
  beforeEach(() => resetPrDiffScopeCache());

  it('reads the diff at the current head', async () => {
    const out = await prefetchPrDiffScopes({ workspaceId: 'w', prNumbers: [7] }, deps({ 7: { head: 'h1', base: 'b1', files: ['a.ts'] } }));
    expect(out.get(7)).toEqual({ paths: ['a.ts'], headSha: 'h1', currentHeadSha: 'h1', observedAt: '2026-10-08T12:00:00.000Z' });
  });

  it('reuses the cached diff while head and base are unchanged (one PR read, no files read)', async () => {
    const prs = { 7: { head: 'h1', base: 'b1', files: ['a.ts'] } };
    await prefetchPrDiffScopes({ workspaceId: 'w', prNumbers: [7] }, deps(prs));
    const calls: string[] = [];
    const out = await prefetchPrDiffScopes({ workspaceId: 'w', prNumbers: [7] }, deps(prs, calls));
    expect(out.get(7)?.paths).toEqual(['a.ts']);
    expect(calls).toEqual(['/repos/o/r/pulls/7']);
  });

  it('re-reads when the head moves', async () => {
    const prs: Record<number, PrState> = { 7: { head: 'h1', base: 'b1', files: ['a.ts'] } };
    await prefetchPrDiffScopes({ workspaceId: 'w', prNumbers: [7] }, deps(prs));
    prs[7] = { head: 'h2', base: 'b1', files: ['a.ts', 'c.ts'] };
    const out = await prefetchPrDiffScopes({ workspaceId: 'w', prNumbers: [7] }, deps(prs));
    expect(out.get(7)).toMatchObject({ paths: ['a.ts', 'c.ts'], headSha: 'h2', currentHeadSha: 'h2' });
  });

  it('returns the older diff marked with its own head when the fresh read fails', async () => {
    const prs: Record<number, PrState> = { 7: { head: 'h1', base: 'b1', files: ['a.ts'] } };
    await prefetchPrDiffScopes({ workspaceId: 'w', prNumbers: [7] }, deps(prs));
    prs[7] = { head: 'h2', base: 'b1', files: ['a.ts'] };
    const d = deps(prs);
    const base = d.github;
    d.github = async (i, p) => { if (p.includes('/files')) throw new Error('boom'); return base(i, p); };
    const out = await prefetchPrDiffScopes({ workspaceId: 'w', prNumbers: [7] }, d);
    expect(out.get(7)).toMatchObject({ headSha: 'h1', currentHeadSha: 'h2' });
  });

  it('omits a PR it cannot read, and never throws', async () => {
    const out = await prefetchPrDiffScopes({ workspaceId: 'w', prNumbers: [9] }, deps({}));
    expect(out.size).toBe(0);
  });

  it('yields nothing without a linked repo', async () => {
    const d = deps({ 7: { head: 'h1', base: 'b1', files: ['a.ts'] } });
    d.resolveRepo = async () => null;
    expect((await prefetchPrDiffScopes({ workspaceId: 'w', prNumbers: [7] }, d)).size).toBe(0);
  });
});
