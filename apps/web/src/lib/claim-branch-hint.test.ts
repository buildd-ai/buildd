import { describe, expect, it } from 'bun:test';
import { claimBranchHint } from './claim-branch-hint';

const base = { interactive: true, sessionBranch: 'codex/personal', sessionCommitsAhead: 23, assignedBranch: 'buildd/abc12345-slice', base: 'mission/x' };

describe('claimBranchHint', () => {
  it('recommends the assigned branch when the session stands on one with its own commits', () => {
    const hint = claimBranchHint(base)!;
    expect(hint).toContain("'codex/personal'");
    expect(hint).toContain('23 commits');
    expect(hint).toContain("'buildd/abc12345-slice'");
    expect(hint).toContain('has not changed your branch');
  });
  it('says nothing for a runner claim, a clean branch, the assigned branch, or unreported state', () => {
    expect(claimBranchHint({ ...base, interactive: false })).toBeNull();
    expect(claimBranchHint({ ...base, sessionCommitsAhead: 0 })).toBeNull();
    expect(claimBranchHint({ ...base, sessionCommitsAhead: undefined })).toBeNull();
    expect(claimBranchHint({ ...base, sessionBranch: 'buildd/abc12345-slice' })).toBeNull();
    expect(claimBranchHint({ ...base, sessionBranch: null })).toBeNull();
  });
});
