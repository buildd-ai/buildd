import { describe, expect, it } from 'bun:test';
import { resolveWarmHandover, isWarmHandoverOptOut } from '../../shared/src/warm-handover';
describe('warm handover policy', () => {
  it('a workspace that says nothing gets the platform default', () => {
    expect(resolveWarmHandover(undefined)).toBe('repo');
    expect(resolveWarmHandover(null)).toBe('repo');
  });
  it('a workspace can only opt out', () => {
    expect(resolveWarmHandover('off')).toBe('off');
    // Values the old team-level selector wrote are opt-ins; they no longer raise anything.
    expect(resolveWarmHandover('repo')).toBe('repo');
    expect(resolveWarmHandover('deps')).toBe('repo');
  });
  it('fails closed on malformed workspace policy', () => {
    for (const v of [true, 'anything', {}, 0]) expect(resolveWarmHandover(v)).toBe('off');
  });
  it('the only writable values are off and null', () => {
    expect(isWarmHandoverOptOut('off')).toBe(true);
    expect(isWarmHandoverOptOut(null)).toBe(true);
    for (const v of ['repo', 'deps', undefined, true, 'anything']) expect(isWarmHandoverOptOut(v)).toBe(false);
  });
});
