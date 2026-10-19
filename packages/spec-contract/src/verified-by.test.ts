import { describe, expect, it } from 'bun:test';
import { VERIFIED_BY, verifiedByOf, verifiedByOfEvidence } from './outcome';

describe('verifiedBy', () => {
  it('names the three signals', () => {
    expect([...VERIFIED_BY]).toEqual(['test', 'review', 'baseline']);
  });

  it('reads the author: check runs are tests, baseline authors are baselines, the rest reviews', () => {
    expect(verifiedByOf('check:abc')).toBe('test');
    expect(verifiedByOf('baseline:abc')).toBe('baseline');
    expect(verifiedByOf('reviewer')).toBe('review');
    expect(verifiedByOf(null)).toBe('review');
  });

  it('reads the author from an evidence blob, tolerating a missing one', () => {
    expect(verifiedByOfEvidence({ recordedBy: 'check:1' })).toBe('test');
    expect(verifiedByOfEvidence({ recordedBy: 'baseline:1' })).toBe('baseline');
    expect(verifiedByOfEvidence({})).toBe('review');
    expect(verifiedByOfEvidence(null)).toBe('review');
  });
});
