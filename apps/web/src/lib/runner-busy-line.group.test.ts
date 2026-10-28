import { describe, expect, test } from 'bun:test';
import { runnerGroupCounts } from './runner-busy-line';

describe('runnerGroupCounts', () => {
  test('header counts every runner, offline ones included, as the rows do', () => {
    const c = runnerGroupCounts([{ online: false, maxSlots: 1, busy: 0 }]);
    expect(c).toEqual({ runners: 1, offline: 1, slots: 1, busy: 0 });
  });
  test('sums slots across online and offline runners', () => {
    const c = runnerGroupCounts([{ online: true, maxSlots: 4, busy: 2 }, { online: false, maxSlots: 8, busy: 0 }]);
    expect(c).toEqual({ runners: 2, offline: 1, slots: 12, busy: 2 });
  });
});
