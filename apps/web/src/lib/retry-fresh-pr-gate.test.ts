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
  retrySubjectPrNumber,
} = await import('./retry-fresh-pr-gate');

const reviewFix = { taskClass: 'attempt', reviewerRetryPrNumber: 70 };
const openSubject = { state: 'open', merged: false, head: { ref: 'buildd/orig-branch', sha: 'subject-sha' }, html_url: 'https://github.com/o/r/pull/70' };
const check = (task: any = reviewFix, head = 'buildd/fix-branch') =>
  checkFreshRetryPr({ installationId: 1, repoFullName: 'o/r', task, head });

beforeEach(() => {
  subjectPr = openSubject;
  compare = { status: 'ahead' };
  mockGithubApi.mockClear();
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

  it('allows a fresh PR, with a durable reason, only when the heads have diverged', async () => {
    compare = { status: 'diverged' };
    expect(await check()).toMatchObject({ action: 'allow_fresh', reason: 'diverged', subjectPrNumber: 70 });
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
