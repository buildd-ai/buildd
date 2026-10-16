import { describe, it, expect } from 'bun:test';
import { normalizePatch, isContentEquivalentHead, readReviewedDelta } from './pr-content-equivalence';

const file = (filename: string, patch: string | undefined, status = 'modified') => ({ filename, status, patch });

describe('normalizePatch', () => {
  it('drops hunk line numbers so a shifted hunk compares equal', () => {
    expect(normalizePatch('@@ -10,3 +10,4 @@ fn()\n a\n+b')).toBe(normalizePatch('@@ -42,3 +43,4 @@ fn()\n a\n+b'));
  });

  it('keeps the changed lines themselves', () => {
    expect(normalizePatch('@@ -1 +1 @@\n-a\n+b')).not.toBe(normalizePatch('@@ -1 +1 @@\n-a\n+c'));
  });
});

describe('isContentEquivalentHead', () => {
  const BASE = { installationId: 1, repoFullName: 'acme/app', baseRef: 'dev', fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40) };

  function apiReturning(byHead: Record<string, unknown>) {
    const calls: string[] = [];
    const api = async (_id: number, path: string) => {
      calls.push(path);
      const head = path.split('...').at(-1)!;
      if (!(head in byHead)) throw new Error('GitHub API error: 404');
      return byHead[head];
    };
    return { api, calls };
  }

  it('is equivalent when a rebase only shifted hunk positions', async () => {
    const { api, calls } = apiReturning({
      [BASE.fromSha]: { files: [file('x.ts', '@@ -10,2 +10,3 @@\n a\n+b')] },
      [BASE.toSha]: { files: [file('x.ts', '@@ -14,2 +14,3 @@\n a\n+b')] },
    });
    expect(await isContentEquivalentHead({ ...BASE, api })).toEqual({ equivalent: true, reason: 'PR diff unchanged' });
    expect(calls).toEqual([`/repos/acme/app/compare/dev...${BASE.fromSha}`, `/repos/acme/app/compare/dev...${BASE.toSha}`]);
  });

  it('is not equivalent when the push changed the PR content', async () => {
    const { api } = apiReturning({
      [BASE.fromSha]: { files: [file('x.ts', '@@ -1 +1 @@\n+b')] },
      [BASE.toSha]: { files: [file('x.ts', '@@ -1 +1 @@\n+c')] },
    });
    expect((await isContentEquivalentHead({ ...BASE, api })).equivalent).toBe(false);
  });

  it('fails closed when a compare read fails', async () => {
    const { api } = apiReturning({ [BASE.toSha]: { files: [] } });
    const result = await isContentEquivalentHead({ ...BASE, api });
    expect(result.equivalent).toBe(false);
    expect(result.reason).toMatch(/could not compare/);
  });

  it('fails closed when the compare file list may be truncated', async () => {
    const many = Array.from({ length: 300 }, (_, i) => file(`f${i}.ts`, '@@ -1 +1 @@\n+x'));
    const { api } = apiReturning({ [BASE.fromSha]: { files: many }, [BASE.toSha]: { files: many } });
    expect((await isContentEquivalentHead({ ...BASE, api })).equivalent).toBe(false);
  });

  it('accepts a file with no patch when its blob is identical at both heads (large generated JSON)', async () => {
    const snapshot = { filename: 'packages/core/drizzle/meta/0179_snapshot.json', status: 'added', sha: 'blob-1' };
    const { api } = apiReturning({
      [BASE.fromSha]: { files: [file('x.ts', '@@ -10,2 +10,3 @@\n a\n+b'), snapshot] },
      [BASE.toSha]: { files: [file('x.ts', '@@ -14,2 +14,3 @@\n a\n+b'), snapshot] },
    });
    expect((await isContentEquivalentHead({ ...BASE, api })).equivalent).toBe(true);
  });

  it('accepts a file whose blob is identical even if the patch text differs in context', async () => {
    const { api } = apiReturning({
      [BASE.fromSha]: { files: [{ ...file('x.ts', '@@ -1 +1 @@\n ctx-old\n+b'), sha: 'same' }] },
      [BASE.toSha]: { files: [{ ...file('x.ts', '@@ -1 +1 @@\n ctx-new\n+b'), sha: 'same' }] },
    });
    expect((await isContentEquivalentHead({ ...BASE, api })).equivalent).toBe(true);
  });

  it('ignores context lines the base changed around the PR\'s own hunk', async () => {
    const { api } = apiReturning({
      [BASE.fromSha]: { files: [{ ...file('x.ts', '@@ -1,3 +1,3 @@ fn\n old-neighbour\n-a\n+b'), sha: 'blob-1' }] },
      [BASE.toSha]: { files: [{ ...file('x.ts', '@@ -1,3 +1,3 @@ fn2\n new-neighbour\n-a\n+b'), sha: 'blob-2' }] },
    });
    expect((await isContentEquivalentHead({ ...BASE, api })).equivalent).toBe(true);
  });

  it('still rejects when the PR\'s own added or removed lines changed', async () => {
    const { api } = apiReturning({
      [BASE.fromSha]: { files: [{ ...file('x.ts', '@@ -1,2 +1,2 @@\n ctx\n-a\n+b'), sha: 'blob-1' }] },
      [BASE.toSha]: { files: [{ ...file('x.ts', '@@ -1,2 +1,2 @@\n ctx\n-a\n+c'), sha: 'blob-2' }] },
    });
    expect((await isContentEquivalentHead({ ...BASE, api })).equivalent).toBe(false);
  });

  it('rejects a patchless file whose blob changed', async () => {
    const { api } = apiReturning({
      [BASE.fromSha]: { files: [{ filename: 'big.json', status: 'added', sha: 'blob-1' }] },
      [BASE.toSha]: { files: [{ filename: 'big.json', status: 'added', sha: 'blob-2' }] },
    });
    expect((await isContentEquivalentHead({ ...BASE, api })).equivalent).toBe(false);
  });

  it('rejects when the set of files changed', async () => {
    const { api } = apiReturning({
      [BASE.fromSha]: { files: [file('x.ts', '@@ -1 +1 @@\n+b')] },
      [BASE.toSha]: { files: [file('x.ts', '@@ -1 +1 @@\n+b'), file('y.ts', '@@ -1 +1 @@\n+y')] },
    });
    expect((await isContentEquivalentHead({ ...BASE, api })).equivalent).toBe(false);
  });

  it('fails closed when a file has no patch', async () => {
    const { api } = apiReturning({
      [BASE.fromSha]: { files: [file('logo.png', undefined)] },
      [BASE.toSha]: { files: [file('logo.png', undefined)] },
    });
    expect((await isContentEquivalentHead({ ...BASE, api })).equivalent).toBe(false);
  });
});

describe('readReviewedDelta (58c8961e)', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const P = { installationId: 1, repoFullName: 'acme/app', baseRef: 'dev', fromSha: A, toSha: B };
  const f = (filename: string, sha: string, o: Record<string, unknown> = {}) => ({ filename, status: 'modified', sha, ...o });
  function api(routes: Record<string, unknown>) {
    return async (_id: number, path: string) => {
      const key = path.replace('/repos/acme/app/compare/', '');
      if (!(key in routes)) throw new Error(`GitHub API error: 404 ${key}`);
      return routes[key];
    };
  }

  it('reads only what the PR itself changed between the two heads, with line counts', async () => {
    const r = await readReviewedDelta({
      ...P,
      api: api({
        [`dev...${A}`]: { files: [f('src/a.ts', 's1'), f('src/a.test.ts', 't1')] },
        [`dev...${B}`]: { files: [f('src/a.ts', 's1'), f('src/a.test.ts', 't2')] },
        // A merge of the base: the direct compare also lists a file the base moved on its own.
        [`${A}...${B}`]: { status: 'ahead', files: [f('src/a.test.ts', 't2', { additions: 3, deletions: 1 }), f('docs/base-only.md', 'x', { additions: 40, deletions: 0 })] },
      }),
    });
    expect(r).toEqual({
      fromHeadSha: A, toHeadSha: B, prFilesAtFrom: ['src/a.ts', 'src/a.test.ts'],
      files: [{ path: 'src/a.test.ts', previousPath: null, status: 'modified', additions: 3, deletions: 1 }],
    });
  });

  it('names a file new to the PR', async () => {
    const r = await readReviewedDelta({
      ...P,
      api: api({
        [`dev...${A}`]: { files: [f('src/a.ts', 's1')] },
        [`dev...${B}`]: { files: [f('src/a.ts', 's1'), f('src/b.ts', 'b1', { status: 'added' })] },
        [`${A}...${B}`]: { status: 'ahead', files: [f('src/b.ts', 'b1', { status: 'added', additions: 5, deletions: 0 })] },
      }),
    });
    expect(r?.files.map((x) => [x.path, x.status])).toEqual([['src/b.ts', 'added']]);
    expect(r?.prFilesAtFrom).toEqual(['src/a.ts']);
  });

  it('is unread (null) when any side fails, may be cut, or a changed file has no line counts', async () => {
    expect(await readReviewedDelta({ ...P, api: api({}) })).toBeNull();
    const many = Array.from({ length: 300 }, (_, i) => f(`f${i}.ts`, 'x'));
    expect(await readReviewedDelta({ ...P, api: api({ [`dev...${A}`]: { files: many }, [`dev...${B}`]: { files: [] }, [`${A}...${B}`]: { files: [] } }) })).toBeNull();
    expect(await readReviewedDelta({
      ...P,
      api: api({ [`dev...${A}`]: { files: [f('src/a.ts', 's1')] }, [`dev...${B}`]: { files: [f('src/a.ts', 's2')] }, [`${A}...${B}`]: { status: 'ahead', files: [] } }),
    })).toBeNull();
  });

  it('a force-push that dropped a reviewed commit (diverged) is unread, never the merge-base diff', async () => {
    // A = base+c1+c2 (c2 added an auth check to x.ts); B = base+c1+c3. The three-dot compare shows only c3.
    const routes = {
      [`dev...${A}`]: { files: [f('src/x.ts', 'x-with-check'), f('src/x.test.ts', 't1')] },
      [`dev...${B}`]: { files: [f('src/x.ts', 'x-without-check'), f('src/x.test.ts', 't2')] },
      [`${A}...${B}`]: { status: 'diverged', files: [f('src/x.test.ts', 't2', { additions: 1, deletions: 0 })] },
    };
    expect(await readReviewedDelta({ ...P, api: api(routes) })).toBeNull();
    for (const status of ['behind', 'identical', undefined]) {
      expect(await readReviewedDelta({ ...P, api: api({ ...routes, [`${A}...${B}`]: { ...routes[`${A}...${B}`], status } }) })).toBeNull();
    }
  });
});
