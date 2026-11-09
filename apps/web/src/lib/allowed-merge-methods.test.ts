import { describe, expect, it, mock } from 'bun:test';
import { allowedMergeMethodsFrom, isMergeMethodRefusal, pickMergeMethod, resolveAllowedMergeMethod } from './allowed-merge-methods';

const allRepo = { allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true };
// The shape GitHub returns for a frozen release target: the repo allows squash, the
// `main` ruleset's pull_request rule allows only merge commits (release #6051).
const mergeOnlyRules = [{ type: 'pull_request', parameters: { allowed_merge_methods: ['merge'] } }];

describe('allowedMergeMethodsFrom', () => {
  it('a ruleset restricts below the repo settings', () => {
    expect(allowedMergeMethodsFrom(allRepo, mergeOnlyRules)).toEqual(['merge']);
  });
  it('repo settings alone restrict', () => {
    expect(allowedMergeMethodsFrom({ allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: false }, [])).toEqual(['merge']);
  });
  it('non-pull_request rules and rules with no method list do not restrict', () => {
    expect(allowedMergeMethodsFrom(allRepo, [{ type: 'required_status_checks' }, { type: 'pull_request', parameters: {} }])).toEqual(['squash', 'merge', 'rebase']);
  });
  it('every pull_request rule is intersected', () => {
    expect(allowedMergeMethodsFrom(allRepo, [
      { type: 'pull_request', parameters: { allowed_merge_methods: ['merge', 'rebase'] } },
      { type: 'pull_request', parameters: { allowed_merge_methods: ['rebase', 'squash'] } },
    ])).toEqual(['rebase']);
  });
});

describe('pickMergeMethod', () => {
  it('keeps squash when allowed', () => expect(pickMergeMethod(['squash', 'merge'])).toBe('squash'));
  it('falls back to merge when squash is not allowed', () => expect(pickMergeMethod(['merge'])).toBe('merge'));
  it('falls back to rebase when only rebase is allowed', () => expect(pickMergeMethod(['rebase'])).toBe('rebase'));
  it('unknown settings keep the preference', () => expect(pickMergeMethod(null)).toBe('squash'));
  it('a base that allows nothing keeps the preference (GitHub decides)', () => expect(pickMergeMethod([])).toBe('squash'));
});

describe('resolveAllowedMergeMethod', () => {
  const base = { installationId: 1, repoFullName: 'o/r', baseRef: 'main' };

  it('no method on a merge-only release target picks merge, not squash', async () => {
    const read = mock(async () => allowedMergeMethodsFrom(allRepo, mergeOnlyRules));
    expect(await resolveAllowedMergeMethod({ ...base, context: {} }, read)).toBe('merge');
    expect(read).toHaveBeenCalledWith(1, 'o/r', 'main');
  });
  it('no method where squash is allowed stays squash', async () => {
    expect(await resolveAllowedMergeMethod({ ...base, context: {} }, async () => ['squash', 'merge', 'rebase'])).toBe('squash');
  });
  it('an explicit method is sent as asked, with no read', async () => {
    const read = mock(async () => ['merge' as const]);
    expect(await resolveAllowedMergeMethod({ ...base, context: {}, requested: 'squash' }, read)).toBe('squash');
    expect(read).not.toHaveBeenCalled();
  });
  it('an integration refresh is always a merge commit', async () => {
    const read = mock(async () => ['squash' as const]);
    const context = { requireMergeCommit: true, refreshTrunk: 'dev' };
    expect(await resolveAllowedMergeMethod({ ...base, context, requested: 'squash' }, read)).toBe('merge');
  });
  it('an unreadable base keeps squash', async () => {
    expect(await resolveAllowedMergeMethod({ ...base, context: {} }, async () => null)).toBe('squash');
  });
});

describe('isMergeMethodRefusal', () => {
  it('matches GitHub 405 method refusals', () => {
    expect(isMergeMethodRefusal('Squash merges are not allowed on this repository.')).toBe(true);
    expect(isMergeMethodRefusal('Rebase merges are not allowed on this repository.')).toBe(true);
  });
  it('does not match real policy failures', () => {
    expect(isMergeMethodRefusal('Repository rule violations found\n\nRequired status check "build" is expected.')).toBe(false);
    expect(isMergeMethodRefusal('At least 1 approving review is required by reviewers with write access.')).toBe(false);
  });
});
