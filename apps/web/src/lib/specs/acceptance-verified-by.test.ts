import { describe, expect, it } from 'bun:test';
import { testNames, testsByCheck, verifiedByUpdate, isTestPath } from './acceptance-verified-by';

const file = (path: string, text: string) => ({ path, text });

describe('AC-123: verified_by lists one test per testable check, by id', () => {
  it('reads test names from it/test calls, not describe blocks', () => {
    const names = testNames(`describe('AC-9 suite', () => { it("AC-3: refuses a stale version", () => {}); test.skip('R-5: x', () => {}); });`);
    expect(names).toEqual(['AC-3: refuses a stale version', 'R-5: x']);
  });

  it('matches a check by its whole id: AC-3 is not AC-33', () => {
    const r = testsByCheck(['AC-3', 'AC-33'], [file('a.test.ts', `it('AC-33: other', () => {});`)]);
    expect(r.byCheck.has('AC-3')).toBe(false);
    expect(r.byCheck.get('AC-33')).toEqual({ path: 'a.test.ts', name: 'AC-33: other' });
    expect(r.untested).toEqual(['AC-3']);
  });

  it('takes one test per check even when several names carry the id', () => {
    const r = testsByCheck(['AC-1'], [file('a.test.ts', `it('AC-1: a', () => {}); it('AC-1: b', () => {});`)]);
    expect(r.byCheck.get('AC-1')?.name).toBe('AC-1: a');
  });

  it('writes a map keyed by check id, keeping a flat list\'s paths', () => {
    const r = testsByCheck(['AC-1', 'AC-2'], [file('t/a.test.ts', `it('AC-1: a', () => {});`), file('t/b.test.ts', `it('AC-2: b', () => {});`)]);
    expect(verifiedByUpdate(['old.test.ts'], r)).toEqual({ 'AC-1': ['old.test.ts', 't/a.test.ts'], 'AC-2': ['t/b.test.ts'] });
    expect(verifiedByUpdate(undefined, r)).toEqual({ 'AC-1': ['t/a.test.ts'], 'AC-2': ['t/b.test.ts'] });
  });

  it('adds to an already keyed map and reports no change when nothing is new', () => {
    const r = testsByCheck(['AC-1', 'AC-2'], [file('t/a.test.ts', `it('AC-1: a', () => {});`), file('t/b.test.ts', `it('AC-2: b', () => {});`)]);
    expect(verifiedByUpdate({ 'AC-1': ['x.test.ts'] }, r)).toEqual({ 'AC-1': ['x.test.ts', 't/a.test.ts'], 'AC-2': ['t/b.test.ts'] });
    expect(verifiedByUpdate({ 'AC-1': ['t/a.test.ts'], 'AC-2': ['t/b.test.ts'] }, r)).toBeNull();
  });

  it('writes nothing when no check has a test', () => {
    expect(verifiedByUpdate(['x.test.ts'], testsByCheck(['AC-1'], []))).toBeNull();
  });

  it('recognises test files', () => {
    expect(isTestPath('apps/web/src/a.test.ts')).toBe(true);
    expect(isTestPath('apps/web/tests/integration/a.ts')).toBe(true);
    expect(isTestPath('apps/web/src/a.ts')).toBe(false);
  });
});
