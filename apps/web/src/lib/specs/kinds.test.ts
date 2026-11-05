import { describe, expect, it } from 'bun:test';
import { DEFAULT_SPEC_KIND, SPEC_KINDS, inMainInboxLane, specKindRefusal } from './kinds';

describe('spec kinds (b7fc9316 R-38)', () => {
  it('has the four kinds and defaults to contract', () => {
    expect([...SPEC_KINDS]).toEqual(['contract', 'charter', 'experiment', 'snapshot']);
    expect(DEFAULT_SPEC_KIND).toBe('contract');
  });
  it('accepts each kind and refuses anything else', () => {
    for (const k of SPEC_KINDS) expect(specKindRefusal(k)).toBeNull();
    expect(specKindRefusal('draft')).toContain('kind must be one of');
    expect(specKindRefusal(5)).toContain('kind must be one of');
  });
  it('only a contract revision is in the main inbox lane', () => {
    expect(inMainInboxLane('contract')).toBe(true);
    for (const k of ['charter', 'experiment', 'snapshot'] as const) expect(inMainInboxLane(k)).toBe(false);
  });
});
