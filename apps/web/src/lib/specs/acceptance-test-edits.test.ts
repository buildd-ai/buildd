import { describe, expect, it } from 'bun:test';
import {
  acceptEdits, criteriaInTestSource, detectAcceptanceTestEdits, excludedCriteria, flagPrEdits, flagText, hasNewPending, pendingEdits, recordDetected,
  type AcceptanceEditsRecord,
} from './acceptance-test-edits';

const TESTS = ['tests/acceptance/specs.test.ts', 'tests/acceptance/mission.test.ts'];

describe('detectAcceptanceTestEdits', () => {
  it('flags a modified acceptance test with the new blob sha', () => {
    const r = detectAcceptanceTestEdits(TESTS, [{ filename: 'tests/acceptance/specs.test.ts', status: 'modified', sha: 'b1' }]);
    expect(r).toEqual([{ path: 'tests/acceptance/specs.test.ts', change: 'edited', blobSha: 'b1' }]);
  });
  it('flags a deleted one', () => {
    const r = detectAcceptanceTestEdits(TESTS, [{ filename: 'tests/acceptance/mission.test.ts', status: 'removed', sha: 'b2' }]);
    expect(r[0]).toMatchObject({ path: 'tests/acceptance/mission.test.ts', change: 'deleted' });
  });
  it('flags a test renamed away, naming the old path', () => {
    const r = detectAcceptanceTestEdits(TESTS, [{ filename: 'tests/other.test.ts', previous_filename: 'tests/acceptance/specs.test.ts', status: 'renamed', sha: 'b3' }]);
    expect(r).toEqual([{ path: 'tests/acceptance/specs.test.ts', change: 'deleted', blobSha: 'b3' }]);
  });
  it('ignores other files, and a file added at an acceptance path', () => {
    expect(detectAcceptanceTestEdits(TESTS, [
      { filename: 'src/app.ts', status: 'modified', sha: 'x' },
      { filename: 'tests/acceptance/specs.test.ts', status: 'added', sha: 'y' },
    ])).toEqual([]);
  });
  it('matches paths exactly, not by prefix or case', () => {
    expect(detectAcceptanceTestEdits(TESTS, [{ filename: 'tests/acceptance/specs.test.ts.bak', status: 'modified', sha: 'x' }, { filename: 'Tests/Acceptance/specs.test.ts', status: 'modified', sha: 'x' }])).toEqual([]);
  });
});

describe('criteriaInTestSource', () => {
  it('reads ids from test names, limited to the scope', () => {
    const src = "it('AC-3: refuses a stale version')\nit('R-5 and AC-9: more')\nit('AC-44: out')";
    expect(criteriaInTestSource(src, ['AC-3', 'AC-9', 'R-5'])).toEqual(['AC-3', 'AC-9', 'R-5']);
  });
  it('does not match inside longer ids', () => {
    expect(criteriaInTestSource("it('AC-31: x')", ['AC-3'])).toEqual([]);
  });
});

const rec = (over: Partial<AcceptanceEditsRecord> = {}): AcceptanceEditsRecord => ({
  prNumber: 7, headSha: 'h1',
  edits: [{ path: 'a.test.ts', change: 'edited', blobSha: 'b1', criteria: ['AC-1'] }],
  accepted: [], ...over,
});

describe('accepting', () => {
  it('a new edit is pending and excludes its criteria', () => {
    expect(pendingEdits(rec())).toHaveLength(1);
    expect([...excludedCriteria([rec()])]).toEqual(['AC-1']);
  });
  it('a person accepting that exact change clears it', () => {
    const r = acceptEdits(rec(), ['a.test.ts'], 'user:u', new Date('2026-10-19T00:00:00Z'));
    expect(pendingEdits(r)).toHaveLength(0);
    expect(excludedCriteria([r]).size).toBe(0);
  });
  it('a later push that changes the test again is pending again', () => {
    const accepted = acceptEdits(rec(), ['a.test.ts'], 'user:u');
    const next = recordDetected(accepted, { prNumber: 7, headSha: 'h2', edits: [{ path: 'a.test.ts', change: 'edited', blobSha: 'b2', criteria: ['AC-1'] }] });
    expect(pendingEdits(next)).toHaveLength(1);
    expect(next.accepted).toHaveLength(1);
  });
  it('a push that keeps the accepted change stays accepted', () => {
    const accepted = acceptEdits(rec(), ['a.test.ts'], 'user:u');
    const next = recordDetected(accepted, { prNumber: 7, headSha: 'h2', edits: [{ path: 'a.test.ts', change: 'edited', blobSha: 'b1', criteria: ['AC-1'] }] });
    expect(pendingEdits(next)).toHaveLength(0);
  });
  it('a push that reverts the edit drops the flag', () => {
    const next = recordDetected(rec(), { prNumber: 7, headSha: 'h2', edits: [] });
    expect(pendingEdits(next)).toHaveLength(0);
  });
  it('accepting a path that was not flagged changes nothing', () => {
    expect(pendingEdits(acceptEdits(rec(), ['zzz.ts'], 'user:u'))).toHaveLength(1);
  });
});

describe('flagText', () => {
  it('names each test, the change and the checks, and says who decides', () => {
    const t = flagText(rec({ edits: [{ path: 'a.test.ts', change: 'deleted', blobSha: 'b', criteria: ['AC-1', 'AC-2'] }] }));
    expect(t).toContain('a.test.ts');
    expect(t).toContain('deleted');
    expect(t).toContain('AC-1, AC-2');
    expect(t).toContain('does not count');
  });
});

describe('flagPrEdits', () => {
  const base = { acceptancePaths: ['a.test.ts'], scope: ['AC-1', 'AC-2'], prev: null, prNumber: 7, headSha: 'h' };
  const files = [{ filename: 'a.test.ts', status: 'modified', sha: 'b' }];
  it('attributes the edit to the checks its test names carry', async () => {
    const r = await flagPrEdits({ ...base, files, readBase: async () => "it('AC-2: x')" });
    expect(r.edits[0].criteria).toEqual(['AC-2']);
  });
  it('holds every in-scope check when the base text cannot be read', async () => {
    const r = await flagPrEdits({ ...base, files, readBase: async () => { throw new Error('404'); } });
    expect(r.edits[0].criteria).toEqual(['AC-1', 'AC-2']);
  });
  it('holds every in-scope check when the test names no id', async () => {
    const r = await flagPrEdits({ ...base, files, readBase: async () => 'nothing' });
    expect(r.edits[0].criteria).toEqual(['AC-1', 'AC-2']);
  });
  it('flags nothing when the PR leaves the tests alone', async () => {
    const r = await flagPrEdits({ ...base, files: [{ filename: 'x.ts', status: 'modified', sha: 'q' }], readBase: async () => '' });
    expect(r.edits).toEqual([]);
  });
});

describe('hasNewPending', () => {
  it('is true for a first flag and a changed blob, false for the same one', () => {
    expect(hasNewPending(null, rec())).toBe(true);
    expect(hasNewPending(rec(), rec({ headSha: 'h2' }))).toBe(false);
    expect(hasNewPending(rec(), rec({ edits: [{ path: 'a.test.ts', change: 'edited', blobSha: 'b9', criteria: ['AC-1'] }] }))).toBe(true);
  });
});
