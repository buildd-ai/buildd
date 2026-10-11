import { describe, expect, it } from 'bun:test';
import { effectiveKeyPolicy, policyColumns, toCredentialPolicy, toInferenceKeyPolicy, isCredentialPolicy } from '../inference-key-policy';

describe('credential policy', () => {
  it('maps the legacy vocabulary one-to-one and back', () => {
    expect(toCredentialPolicy('team')).toBe('team');
    expect(toCredentialPolicy('team_or_own')).toBe('personal_first');
    expect(toCredentialPolicy('own')).toBe('personal_only');
    for (const p of ['team', 'personal_first', 'personal_only'] as const) {
      expect(toCredentialPolicy(toInferenceKeyPolicy(p))).toBe(p);
    }
  });

  it('prefers credentialPolicy over inferenceKeyPolicy', () => {
    expect(effectiveKeyPolicy({ credentialPolicy: 'personal_only', inferenceKeyPolicy: 'team' })).toBe('own');
  });

  it('falls back to inferenceKeyPolicy when credentialPolicy is unset or unknown', () => {
    expect(effectiveKeyPolicy({ credentialPolicy: null, inferenceKeyPolicy: 'team_or_own' })).toBe('team_or_own');
    expect(effectiveKeyPolicy({ credentialPolicy: 'bogus', inferenceKeyPolicy: 'team' })).toBe('team');
  });

  it('is null when neither column is known, so callers keep their own fallback', () => {
    expect(effectiveKeyPolicy({ credentialPolicy: null, inferenceKeyPolicy: 'x' })).toBeNull();
    expect(effectiveKeyPolicy(null)).toBeNull();
  });

  it('writes both columns from either vocabulary', () => {
    expect(policyColumns('own')).toEqual({ credentialPolicy: 'personal_only', inferenceKeyPolicy: 'own' });
    expect(policyColumns('personal_first')).toEqual({ credentialPolicy: 'personal_first', inferenceKeyPolicy: 'team_or_own' });
    expect(isCredentialPolicy('team_or_own')).toBe(false);
  });
});
