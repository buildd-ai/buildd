import { describe, it, expect, beforeEach, mock } from 'bun:test';

let subjectPr: any = null;
let compare: any = null;
const mockGithubApi = mock(async (_inst: number, path: string) => {
  if (/\/compare\//.test(path)) {
    if (compare instanceof Error) throw compare;
    return compare;
  }
  if (subjectPr instanceof Error) throw subjectPr;
  return subjectPr;
});
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));

const {
  checkFreshRetryPr,
  decideFreshRetryPr,
  freshRetryPrRefusal,
  retryAttemptFooter,
  ATTEMPT_FOOTER_PATTERN,
  retrySubjectPrNumber,
} = await import('./retry-fresh-pr-gate');

const reviewFix = { taskClass: 'attempt', reviewerRetryPrNumber: 70 };
const openSubject = { state: 'open', merged: false, head: { ref: 'buildd/orig-branch', sha: 'subject-sha' }, html_url: 'https://github.com/o/r/pull/70' };
let resumeCause: string = 'unknown';
const mockResolveResumeCause = mock(async () => resumeCause as any);
const check = (task: any = reviewFix, head = 'buildd/fix-branch') =>
  checkFreshRetryPr({ installationId: 1, repoFullName: 'o/r', task, head, resolveResumeCause: mockResolveResumeCause });

beforeEach(() => {
  subjectPr = openSubject;
  compare = { status: 'ahead' };
  resumeCause = 'unknown';
  mockGithubApi.mockClear();
  mockResolveResumeCause.mockClear();
});

describe('retrySubjectPrNumber', () => {
  it('reads the retry key of an attempt, any kind', () => {
    expect(retrySubjectPrNumber(reviewFix)).toBe(70);
    expect(retrySubjectPrNumber({ taskClass: 'attempt', ciRetryPrNumber: 71 })).toBe(71);
    expect(retrySubjectPrNumber({ taskClass: 'attempt', conflictRetryPrNumber: 72 })).toBe(72);
  });

  it('is null for a task that is not a retry', () => {
    expect(retrySubjectPrNumber({ taskClass: 'work', reviewerRetryPrNumber: 70 })).toBeNull();
    expect(retrySubjectPrNumber(null)).toBeNull();
  });
});

describe('checkFreshRetryPr', () => {
  it('REGRESSION (lineage fork): refuses a second PR when the retry branch only adds commits to the open subject PR', async () => {
    // The runner could not check out the subject branch (held by a sibling
    // worktree) and cut a fresh one from the same tip.
    const d = await check();
    expect(d).toMatchObject({ action: 'refuse', subjectPrNumber: 70, subjectHeadRef: 'buildd/orig-branch', compareStatus: 'ahead' });
    const compareCall = mockGithubApi.mock.calls.find((c: any[]) => String(c[1]).includes('/compare/'));
    expect(compareCall?.[1]).toBe('/repos/o/r/compare/subject-sha...buildd%2Ffix-branch');
  });

  it('refuses when there is nothing new, too (identical or behind)', async () => {
    for (const status of ['identical', 'behind']) {
      compare = { status };
      expect((await check()).action).toBe('refuse');
    }
  });

  it('allows a fresh PR only when the heads diverged AND the runner recorded why it could not resume', async () => {
    compare = { status: 'diverged' };
    for (const cause of ['missing', 'diverged']) {
      resumeCause = cause;
      expect(await check()).toMatchObject({ action: 'allow_fresh', reason: 'diverged', subjectPrNumber: 70, resumeCause: cause });
    }
  });

  it('REGRESSION (resume failed; new branch): refuses a diverged head the runner never proved it could not resume', async () => {
    // The worker started from trunk instead of the open PR's head and nothing
    // recorded why. Divergence alone proves only that it did not resume.
    compare = { status: 'diverged' };
    for (const cause of ['unknown', 'checked_out']) {
      resumeCause = cause;
      const d = await check();
      expect(d).toMatchObject({ action: 'refuse', subjectPrNumber: 70, compareStatus: 'diverged' });
      if (d.action !== 'refuse') throw new Error('expected refuse');
      const { error, hint } = freshRetryPrRefusal(d, 'buildd/fix-branch');
      expect(error).toContain('PR #70');
      expect(hint).toContain('rebase');
      expect(hint).toContain('buildd/orig-branch');
    }
  });

  it('only asks for the runner trace when the heads diverged', async () => {
    await check();
    expect(mockResolveResumeCause).not.toHaveBeenCalled();
  });

  it('allows normally once the subject PR is closed or merged', async () => {
    subjectPr = { ...openSubject, state: 'closed' };
    expect(await check()).toEqual({ action: 'allow', reason: 'subject_not_open' });
    subjectPr = { ...openSubject, state: 'closed', merged: true };
    expect(await check()).toEqual({ action: 'allow', reason: 'subject_not_open' });
  });

  it('allows the subject branch itself (create_pr adopts the existing PR)', async () => {
    expect(await check(reviewFix, 'buildd/orig-branch')).toEqual({ action: 'allow', reason: 'same_branch' });
  });

  it('makes no GitHub call for a task that is not a retry', async () => {
    expect(await check({ taskClass: 'work' })).toEqual({ action: 'allow', reason: 'not_a_retry' });
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('fails open, recorded as unverified, when GitHub cannot be read', async () => {
    subjectPr = new Error('502');
    expect(await check()).toMatchObject({ action: 'allow_fresh', reason: 'unverified' });
    subjectPr = openSubject;
    compare = new Error('502');
    expect(await check()).toMatchObject({ action: 'allow_fresh', reason: 'unverified' });
  });
});

describe('freshRetryPrRefusal', () => {
  it('tells the worker to fast-forward the subject branch and record it', () => {
    const d = decideFreshRetryPr({
      subjectPrNumber: 70,
      subject: { number: 70, state: 'open', merged: false, headRef: 'buildd/orig-branch', headSha: 's', url: null },
      head: 'buildd/fix-branch',
      compareStatus: 'ahead',
    });
    if (d.action !== 'refuse') throw new Error('expected refuse');
    const { hint } = freshRetryPrRefusal(d, 'buildd/fix-branch');
    expect(hint).toContain('git push origin HEAD:buildd/orig-branch');
    expect(hint).toContain("head='buildd/orig-branch'");
  });
});

describe('retryAttemptFooter — the PR says why a retry opened a new PR, or that it did not', () => {
  it('names the runner cause and the compare when a diverged head was let through', () => {
    const f = retryAttemptFooter({
      attempt: 2, maxIterations: 3,
      decision: { action: 'allow_fresh', reason: 'diverged', subjectPrNumber: 70, compareStatus: 'diverged', resumeCause: 'missing' },
    });
    expect(f).toBe("_Attempt 2/3 — new PR: PR #70's branch was missing on the runner and the heads diverged._");
  });

  it('says unverified when GitHub could not be read, and never claims a failed resume', () => {
    const f = retryAttemptFooter({
      attempt: 2, maxIterations: 3,
      decision: { action: 'allow_fresh', reason: 'unverified', subjectPrNumber: 70, compareStatus: null },
    });
    expect(f).toBe("_Attempt 2/3 — new PR: PR #70's head could not be verified._");
    expect(f).not.toContain('resume failed');
  });

  it('says the subject was no longer open when that is why', () => {
    expect(retryAttemptFooter({ attempt: 2, maxIterations: 3, decision: { action: 'allow', reason: 'subject_not_open' } }))
      .toBe('_Attempt 2/3 — new PR: the PR it was fixing is no longer open._');
  });

  it('says "updated this PR" when create_pr adopted the existing one', () => {
    expect(retryAttemptFooter({ attempt: 2, maxIterations: 3, decision: 'updated' }))
      .toBe('_Attempt 2/3 — updated this PR._');
  });

  it('the replace pattern matches every footer variant, including the old wording', () => {
    for (const line of [
      '_Attempt 2/3 — resume failed; new branch._',
      '_Attempt 3/3 — updated this PR._',
      "_Attempt 2/3 — new PR: PR #70's head could not be verified._",
    ]) {
      expect(new RegExp(ATTEMPT_FOOTER_PATTERN.source).test(`body\n\n---\n${line}`)).toBe(true);
    }
  });
});
