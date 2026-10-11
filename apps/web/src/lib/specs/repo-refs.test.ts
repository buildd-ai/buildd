import { describe, expect, it } from 'bun:test';
import { MAX_REPO_REFS, newRepoRefs, normalizeCommitSha, normalizeRepoPath, parseRepoRefs, sameRepoRefs } from './repo-refs';

const SHA = 'a'.repeat(40);
const SHA2 = '0123456789abcdef0123456789abcdef01234567';

describe('repo spec references', () => {
  it('accepts a repo-relative path and normalizes a leading ./', () => {
    expect(normalizeRepoPath('docs/specs/checkout.md')).toBe('docs/specs/checkout.md');
    expect(normalizeRepoPath('  ./docs/specs/checkout.md ')).toBe('docs/specs/checkout.md');
  });

  it('refuses a path that could leave the repo or is not a file path', () => {
    for (const p of ['/etc/passwd', '../secrets.md', 'docs/../../x', 'docs//x.md', 'docs/', 'docs\\x.md', 'docs/./x.md', '', 'a\u0000b', 42, null]) {
      expect(normalizeRepoPath(p)).toBeNull();
    }
  });

  it('takes only a full commit SHA: never a branch name or a short SHA', () => {
    expect(normalizeCommitSha(SHA.toUpperCase())).toBe(SHA);
    for (const s of ['main', 'dev', SHA.slice(0, 12), `${SHA}0`, 'g'.repeat(40), 7]) expect(normalizeCommitSha(s)).toBeNull();
  });

  it('parses a list, collapses duplicates and caps its size', () => {
    const r = parseRepoRefs([{ path: 'docs/a.md', commitSha: SHA }, { path: './docs/a.md', commitSha: SHA.toUpperCase() }, { path: 'docs/b.md', commitSha: SHA2 }]);
    expect(r).toEqual({ ok: true, refs: [{ path: 'docs/a.md', commitSha: SHA }, { path: 'docs/b.md', commitSha: SHA2 }] });
    const many = Array.from({ length: MAX_REPO_REFS + 1 }, (_, i) => ({ path: `docs/${i}.md`, commitSha: SHA }));
    expect(parseRepoRefs(many).ok).toBe(false);
    expect(parseRepoRefs('docs/a.md').ok).toBe(false);
    const bad = parseRepoRefs([{ path: 'docs/a.md', commitSha: 'main' }]);
    expect(!bad.ok && bad.error).toContain('repoRefs[0].commitSha');
  });

  it('compares sets regardless of order and finds the ones not yet validated', () => {
    const a = { path: 'docs/a.md', commitSha: SHA };
    const b = { path: 'docs/b.md', commitSha: SHA2 };
    expect(sameRepoRefs([a, b], [b, a])).toBe(true);
    expect(sameRepoRefs([a], [a, b])).toBe(false);
    expect(sameRepoRefs(null, [])).toBe(true);
    expect(newRepoRefs([a, b], [a])).toEqual([b]);
  });
});
