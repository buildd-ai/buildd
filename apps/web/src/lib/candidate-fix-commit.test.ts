import { describe, it, expect } from 'bun:test';
import { commitShaOf, releaseCandidateFixOf, verifyCandidateFixCommit } from './candidate-fix-commit';
import { RELEASE_CANDIDATE_FIX_KEY } from '@/lib/release-candidate-ci';

const fix = { prNumber: 90, headSha: 'cand0000cand', version: '1.2.3', branch: 'release/v1.2.3', sourceBranch: 'dev' };
const FULL = 'b9c6a996b0000000000000000000000000000000';

/** GitHub as seen by compare: `ancestors[head]` lists what each head contains. */
function api(opts: { commit?: string | null; ancestors: Record<string, string[]> }) {
  const calls: string[] = [];
  const fn = async (_i: number, path: string) => {
    calls.push(path);
    let m: RegExpExecArray | null;
    if ((m = /\/commits\/([^/]+)$/.exec(path))) {
      if (opts.commit === null) throw new Error('404');
      return { sha: opts.commit ?? FULL };
    }
    if ((m = /\/compare\/([^.]+)\.\.\.(.+)$/.exec(path))) {
      return { status: (opts.ancestors[m[2]] ?? []).includes(m[1]) ? 'ahead' : 'diverged' };
    }
    throw new Error(`unexpected ${path}`);
  };
  return { fn, calls };
}

it('keeps the fix-context key in step with release-candidate-ci', () => {
  expect(releaseCandidateFixOf({ [RELEASE_CANDIDATE_FIX_KEY]: { prNumber: 1, headSha: 'a', version: '1.0.0', branch: 'release/v1.0.0', sourceBranch: 'dev' } })).not.toBeNull();
});

describe('commitShaOf', () => {
  it('takes a short or full hex sha, and leaves a bare number to mean a PR', () => {
    expect(commitShaOf('b9c6a996b')).toBe('b9c6a996b');
    expect(commitShaOf(' B9C6A996B ')).toBe('b9c6a996b');
    expect(commitShaOf(FULL)).toBe(FULL);
    expect(commitShaOf('5647')).toBeNull();
    expect(commitShaOf(5647)).toBeNull();
    expect(commitShaOf('#5647')).toBeNull();
    expect(commitShaOf('abc')).toBeNull();
    expect(commitShaOf(null)).toBeNull();
  });
});

describe('releaseCandidateFixOf', () => {
  it('reads the candidate a fix task was filed for, and nothing from an ordinary task', () => {
    expect(releaseCandidateFixOf({ [RELEASE_CANDIDATE_FIX_KEY]: fix })).toEqual(fix);
    expect(releaseCandidateFixOf({ baseBranch: 'dev' })).toBeNull();
    expect(releaseCandidateFixOf(null)).toBeNull();
  });
});

describe('verifyCandidateFixCommit', () => {
  it('accepts a commit on the source branch that the red candidate does not hold, with its full sha', async () => {
    const g = api({ ancestors: { dev: [FULL], [fix.headSha]: [] } });
    const out = await verifyCandidateFixCommit({ api: g.fn, installationId: 7, repoFullName: 'o/r', sha: 'b9c6a996b', fix });
    expect(out).toEqual({ ok: true, landed: { commitSha: FULL, sourceBranch: 'dev', candidatePr: 90 } });
  });

  it('refuses a commit that is not on the source branch', async () => {
    const g = api({ ancestors: { dev: [], [fix.headSha]: [] } });
    const out = await verifyCandidateFixCommit({ api: g.fn, installationId: 7, repoFullName: 'o/r', sha: 'b9c6a996b', fix });
    expect(out.ok).toBe(false);
    expect((out as any).refusal).toContain('is not on `dev`');
  });

  it('refuses a commit the red candidate already holds: it cannot be the fix', async () => {
    const g = api({ ancestors: { dev: [FULL], [fix.headSha]: [FULL] } });
    const out = await verifyCandidateFixCommit({ api: g.fn, installationId: 7, repoFullName: 'o/r', sha: 'b9c6a996b', fix });
    expect(out.ok).toBe(false);
    expect((out as any).refusal).toContain('already in release candidate v1.2.3');
  });

  it('refuses a commit GitHub does not know', async () => {
    const g = api({ commit: null, ancestors: {} });
    const out = await verifyCandidateFixCommit({ api: g.fn, installationId: 7, repoFullName: 'o/r', sha: 'deadbeef1', fix });
    expect(out.ok).toBe(false);
    expect((out as any).refusal).toContain('could not be read');
  });
});
