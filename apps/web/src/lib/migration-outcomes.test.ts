import { describe, it, expect } from 'bun:test';
import { formatOutcomeDetail, isPhaseSuccess, formatPhaseLabel } from './migration-outcomes';

describe('formatOutcomeDetail', () => {
  // Regression: the modal crashed because object details were rendered as React children.
  it('never returns an object — the crash guard', () => {
    for (const input of [{ moved: true }, { deletedSecrets: ['x'] }, { checklistArtifactId: 'a' }, {}, { nested: { a: 1 } }]) {
      const out = formatOutcomeDetail(input);
      expect(out === null || typeof out === 'string').toBe(true);
    }
  });

  it('summarizes boolean and array/scalar object fields', () => {
    expect(formatOutcomeDetail({ moved: true })).toBe('moved');
    expect(formatOutcomeDetail({ deletedSecrets: ['a', 'b'] })).toBe('deletedSecrets: a, b');
    expect(formatOutcomeDetail({ checklistArtifactId: 'art-1' })).toBe('checklistArtifactId: art-1');
  });

  it('returns null for empty or no-op details', () => {
    expect(formatOutcomeDetail({})).toBeNull();
    expect(formatOutcomeDetail({ removedAccounts: [], severedDeps: [] })).toBeNull();
    expect(formatOutcomeDetail({ moved: false })).toBeNull();
    expect(formatOutcomeDetail(null)).toBeNull();
    expect(formatOutcomeDetail(undefined)).toBeNull();
  });

  it('passes through strings', () => {
    expect(formatOutcomeDetail('hello')).toBe('hello');
    expect(formatOutcomeDetail('')).toBeNull();
  });
});

describe('isPhaseSuccess', () => {
  it('treats completed/skipped/ok as success', () => {
    expect(isPhaseSuccess('completed')).toBe(true);
    expect(isPhaseSuccess('skipped')).toBe(true);
    expect(isPhaseSuccess('ok')).toBe(true);
  });
  it('treats anything else as not-success', () => {
    expect(isPhaseSuccess('failed')).toBe(false);
    expect(isPhaseSuccess('pending')).toBe(false);
    expect(isPhaseSuccess(null)).toBe(false);
  });
});

describe('formatPhaseLabel', () => {
  it('replaces underscores with spaces', () => {
    expect(formatPhaseLabel('clear_account_workspaces')).toBe('clear account workspaces');
  });
});
