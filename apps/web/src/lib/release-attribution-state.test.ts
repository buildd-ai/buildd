process.env.NODE_ENV = 'test';

import { describe, it, expect } from 'bun:test';
import { deriveReleaseAttributionState } from './release-attribution-state';

describe('deriveReleaseAttributionState', () => {
  it('commitsAheadAtDispatch === 0 → clean, regardless of sha state', () => {
    expect(
      deriveReleaseAttributionState({
        commitsAheadAtDispatch: 0,
        previousSha: null,
        headSha: null,
        attributedCount: 0,
      }),
    ).toBe('clean');
  });

  it('live example cc2d33a6: 0 commits ahead + null headSha → clean, not unseeded', () => {
    expect(
      deriveReleaseAttributionState({
        commitsAheadAtDispatch: 0,
        previousSha: 'abc1234',
        headSha: null,
        attributedCount: 0,
      }),
    ).toBe('clean');
  });

  it('previousSha === headSha (non-null) → clean even if commitsAheadAtDispatch is unset', () => {
    expect(
      deriveReleaseAttributionState({
        commitsAheadAtDispatch: null,
        previousSha: 'sameSha',
        headSha: 'sameSha',
        attributedCount: 0,
      }),
    ).toBe('clean');
  });

  it('non-empty range, missing headSha, nothing attributed → unseeded (attribution could not run)', () => {
    expect(
      deriveReleaseAttributionState({
        commitsAheadAtDispatch: 5,
        previousSha: 'abc1234',
        headSha: null,
        attributedCount: 0,
      }),
    ).toBe('unseeded');
  });

  it('non-empty range, missing previousSha, nothing attributed → unseeded', () => {
    expect(
      deriveReleaseAttributionState({
        commitsAheadAtDispatch: 5,
        previousSha: null,
        headSha: 'def5678',
        attributedCount: 0,
      }),
    ).toBe('unseeded');
  });

  it('commitsAheadAtDispatch unknown (null) and no shas at all, nothing attributed → unseeded', () => {
    expect(
      deriveReleaseAttributionState({
        commitsAheadAtDispatch: null,
        previousSha: null,
        headSha: null,
        attributedCount: 0,
      }),
    ).toBe('unseeded');
  });

  it('valid distinct sha range, attribution ran, nothing matched → unmatched (real signal)', () => {
    expect(
      deriveReleaseAttributionState({
        commitsAheadAtDispatch: 5,
        previousSha: 'abc1234',
        headSha: 'def5678',
        attributedCount: 0,
      }),
    ).toBe('unmatched');
  });

  it('valid distinct sha range, tasks attributed → attributed', () => {
    expect(
      deriveReleaseAttributionState({
        commitsAheadAtDispatch: 3,
        previousSha: 'abc1234',
        headSha: 'def5678',
        attributedCount: 2,
      }),
    ).toBe('attributed');
  });

  it('missing shas but tasks somehow attributed → attributed still wins over unseeded', () => {
    expect(
      deriveReleaseAttributionState({
        commitsAheadAtDispatch: 3,
        previousSha: null,
        headSha: null,
        attributedCount: 1,
      }),
    ).toBe('attributed');
  });
});
