import { describe, expect, it } from 'bun:test';
import { flattenVerifiedBy, planAcceptanceRecord, testNameCarriesId, validVerifiedBy } from './acceptance-tests';

describe('acceptance tests recorded by check id (R-77)', () => {
  it('AC-123: a test name carries its check id as a whole token', () => {
    expect(testNameCarriesId('AC-3: refuses a stale version', 'AC-3')).toBe(true);
    expect(testNameCarriesId('AC-33: other', 'AC-3')).toBe(false);
    expect(testNameCarriesId('refuses a stale version', 'AC-3')).toBe(false);
    expect(testNameCarriesId('xAC-3: other', 'AC-3')).toBe(false);
  });

  it('AC-123: records one entry per testable check, keyed by id', () => {
    const plan = planAcceptanceRecord(
      [{ id: 'AC-1', testable: true }, { id: 'AC-2', testable: true }, { id: 'AC-3', testable: false, why: 'looks right on screen' }],
      [{ path: 'a/x.test.ts', name: 'AC-1: a' }, { path: 'a/y.test.ts', name: 'AC-2: b' }],
    );
    expect(plan.verifiedBy).toEqual({ 'AC-1': ['a/x.test.ts'], 'AC-2': ['a/y.test.ts'] });
    expect(plan.untested).toEqual([{ id: 'AC-3', why: 'looks right on screen' }]);
    expect(plan.problems).toEqual([]);
  });

  it('AC-123: a testable check with no test, a test without a known id, and an untestable check with no reason are problems', () => {
    const plan = planAcceptanceRecord(
      [{ id: 'AC-1', testable: true }, { id: 'AC-4', testable: false }],
      [{ path: 'a/x.test.ts', name: 'refuses' }],
    );
    expect(plan.problems).toEqual([
      'AC-1 is testable but has no test with its id in the name',
      'AC-4 is not testable and says no reason (R-82)',
      'test "refuses" in a/x.test.ts names no check in scope',
    ]);
  });

  it('AC-123: verified_by accepts a path list or a map keyed by check id, and flattens to paths', () => {
    expect(validVerifiedBy(['a/x.test.ts'])).toBe(true);
    expect(validVerifiedBy({ 'AC-1': ['a/x.test.ts'] })).toBe(true);
    expect(validVerifiedBy({ 'not an id': ['a/x.test.ts'] })).toBe(false);
    expect(validVerifiedBy({ 'AC-1': [] })).toBe(false);
    expect(flattenVerifiedBy({ 'AC-1': ['b.ts', 'a.ts'], 'AC-2': ['a.ts'] })).toEqual(['b.ts', 'a.ts']);
    expect(flattenVerifiedBy(undefined)).toEqual([]);
  });
});
