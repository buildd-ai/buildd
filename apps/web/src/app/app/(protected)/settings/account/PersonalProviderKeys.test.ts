import { describe, expect, it } from 'bun:test';
import { inUseLabel } from './PersonalProviderKeys';
import { toKeyStatus } from '@/lib/provider-keys-client';

// Illustrative fixtures only.
const key = (health: string, scope: 'user' | 'team') => toKeyStatus({
  id: `k-${scope}`, provider: 'openrouter', scope, last4: 'abcd', health: health as never,
  lastVerifiedAt: null, lastVerificationError: null, updatedAt: '2026-09-26T10:00:00Z', source: 'inference_key',
});

describe('inUseLabel', () => {
  it('names your key when you have a working one', () => {
    expect(inUseLabel({ provider: 'openrouter', mine: key('healthy', 'user'), team: key('healthy', 'team'), membersWithOwnKey: null })).toBe('your key');
  });

  it('falls back to the team key when yours was rejected', () => {
    expect(inUseLabel({ provider: 'openrouter', mine: key('revoked', 'user'), team: key('healthy', 'team'), membersWithOwnKey: null })).toBe('the team key');
  });

  it('says so when nothing resolves', () => {
    expect(inUseLabel({ provider: 'openrouter', mine: null, team: null, membersWithOwnKey: null })).toBe('no key yet');
    expect(inUseLabel(undefined)).toBe('no key yet');
  });
});
