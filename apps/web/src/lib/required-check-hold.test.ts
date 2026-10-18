/**
 * GitHub's refusal to merge while a required check has not passed yet is a
 * wait, not a refusal (workflow-kernel-library.md §4, merge holds).
 */
import { describe, expect, test } from 'bun:test';
import { requiredCheckHold } from './required-check-hold';

describe('requiredCheckHold', () => {
  test('a required check that is expected or still running is a hold, named', () => {
    expect(requiredCheckHold('Required status check "Buildd / Review approval" is expected.')).toEqual({ check: 'Buildd / Review approval' });
    expect(requiredCheckHold('Required status check "build" is in progress.')).toEqual({ check: 'build' });
    expect(requiredCheckHold('Required status check "build" is pending.')).toEqual({ check: 'build' });
    expect(requiredCheckHold('Repository rule violations found\n\nRequired status check "build" is expected.\n\n')).toEqual({ check: 'build' });
  });

  test('several checks, or a count, still hold; the first named check is the one reported', () => {
    expect(requiredCheckHold('Required status checks "build", "release candidate verified" are expected.')).toEqual({ check: 'build' });
    expect(requiredCheckHold('2 of 3 required status checks are expected.')).toEqual({ check: null });
    expect(requiredCheckHold('2 of 2 required status checks have not succeeded: 1 expected and 1 pending.')).toEqual({ check: null });
  });

  test('read out of a thrown GitHub API error with an escaped JSON body', () => {
    const err = 'GitHub API error: 405 {"message":"Required status check \\"build\\" is expected.","documentation_url":"https://docs.github.com/rest"}';
    expect(requiredCheckHold(err)).toEqual({ check: 'build' });
  });

  test('anything else is not a hold: a failing check, a conflict, a review requirement, nothing at all', () => {
    expect(requiredCheckHold('Required status check "build" is failing.')).toBeNull();
    expect(requiredCheckHold('Pull Request is not mergeable')).toBeNull();
    expect(requiredCheckHold('At least 1 approving review is required by reviewers with write access.')).toBeNull();
    expect(requiredCheckHold('Head branch was modified. Review and try the merge again.')).toBeNull();
    expect(requiredCheckHold(null)).toBeNull();
    expect(requiredCheckHold('')).toBeNull();
  });
});
