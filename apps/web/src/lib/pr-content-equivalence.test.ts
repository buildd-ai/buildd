import { describe, it, expect } from 'bun:test';
import { normalizePatch, isContentEquivalentHead } from './pr-content-equivalence';

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
