import { describe, expect, it } from 'bun:test';
import { nativeHistoryData } from './native-history';

describe('nativeHistoryData', () => {
  it('drops the markers that make the App Router skip its sync', () => {
    const next = { __NA: true, _N: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: [] }, mine: 1 };
    expect(nativeHistoryData(next)).toEqual({ mine: 1 });
  });

  it('never returns the input object, so the caller cannot mutate live history state', () => {
    const state = { mine: 1 };
    expect(nativeHistoryData(state)).not.toBe(state);
  });

  it('is an empty object for null, undefined and non-objects', () => {
    expect(nativeHistoryData(null)).toEqual({});
    expect(nativeHistoryData(undefined)).toEqual({});
    expect(nativeHistoryData('x')).toEqual({});
  });
});
