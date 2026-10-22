import { describe, expect, it } from 'bun:test';
import { SPEC_SCOPES } from '@buildd/core/db/schema';
import { CREATABLE_SPEC_SCOPES, specScopeRefusal } from './scopes';

// Living Specs D-45: the mission scope retires. Existing rows keep the value.
describe('specScopeRefusal', () => {
  it('refuses a new mission-scope spec, pointing at selecting one instead', () => {
    const err = specScopeRefusal('mission');
    expect(err).toContain('retired');
    expect(err).toContain('outcomeSpec');
  });

  it('accepts product, domain and feature', () => {
    for (const s of ['product', 'domain', 'feature']) expect(specScopeRefusal(s)).toBeNull();
    expect([...CREATABLE_SPEC_SCOPES]).toEqual(['product', 'domain', 'feature']);
  });

  it('refuses an unknown scope, naming only the creatable ones', () => {
    expect(specScopeRefusal('epic')).toBe('scope must be one of: product, domain, feature');
  });

  it('keeps mission a stored value, so existing mission-scope specs stay readable', () => {
    expect(SPEC_SCOPES as readonly string[]).toContain('mission');
  });
});
