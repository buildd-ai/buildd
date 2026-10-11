import { describe, it, expect } from 'bun:test';
import { collectPolicySuggestions, applyPolicySuggestions } from './policy-suggestions';
import type { WorkspacePolicyConfig } from '@buildd/shared';

const policy: WorkspacePolicyConfig = {
  preset: 'balanced',
  riskClasses: [{ name: 'dependency_bump', detectedPaths: ['package.json'] }],
};

describe('collectPolicySuggestions', () => {
  it('dedupes across reviews and ignores malformed context', () => {
    const out = collectPolicySuggestions([
      { policySuggestions: [{ path: 'apps/api/package.json', class: 'dependency_bump' }] },
      { policySuggestions: [{ path: 'apps/api/package.json', class: 'dependency_bump' }, { path: 'lib/auth/session.ts', class: 'auth_and_secrets' }] },
      { policySuggestions: 'nope' },
      null,
      { policySuggestions: [{ path: 42 }] },
    ], policy);
    expect(out).toEqual([
      { path: 'apps/api/package.json', class: 'dependency_bump' },
      { path: 'lib/auth/session.ts', class: 'auth_and_secrets' },
    ]);
  });

  it('drops a path the policy has since come to cover', () => {
    const covered: WorkspacePolicyConfig = { ...policy, riskClasses: [{ name: 'dependency_bump', detectedPaths: ['apps/api/package.json'] }] };
    expect(collectPolicySuggestions([{ policySuggestions: [{ path: 'apps/api/package.json', class: 'dependency_bump' }] }], covered)).toEqual([]);
  });

  it('re-derives the class rather than trusting the stored one', () => {
    expect(collectPolicySuggestions([{ policySuggestions: [{ path: 'apps/api/package.json', class: 'auth_and_secrets' }] }], policy))
      .toEqual([{ path: 'apps/api/package.json', class: 'dependency_bump' }]);
  });

  it('a path that is not risk-adjacent never becomes a suggestion', () => {
    expect(collectPolicySuggestions([{ policySuggestions: [{ path: 'src/button.tsx', class: 'dependency_bump' }] }], policy)).toEqual([]);
  });

  it('no policy means nothing to be uncovered by', () => {
    expect(collectPolicySuggestions([{ policySuggestions: [{ path: 'apps/api/package.json', class: 'dependency_bump' }] }], null)).toEqual([]);
  });
});

describe('applyPolicySuggestions', () => {
  it('appends to an existing class and creates a missing one, without touching other fields', () => {
    const next = applyPolicySuggestions({ ...policy, reviewerRole: 'reviewer' }, [
      { path: 'apps/api/package.json', class: 'dependency_bump' },
      { path: 'lib/auth/session.ts', class: 'auth_and_secrets' },
    ]);
    expect(next.reviewerRole).toBe('reviewer');
    expect(next.riskClasses).toEqual([
      { name: 'dependency_bump', detectedPaths: ['package.json', 'apps/api/package.json'] },
      { name: 'auth_and_secrets', detectedPaths: ['lib/auth/session.ts'] },
    ]);
    expect(policy.riskClasses[0].detectedPaths).toEqual(['package.json']);
  });

  it('is idempotent', () => {
    const s = [{ path: 'apps/api/package.json', class: 'dependency_bump' as const }];
    expect(applyPolicySuggestions(applyPolicySuggestions(policy, s), s)).toEqual(applyPolicySuggestions(policy, s));
  });
});
