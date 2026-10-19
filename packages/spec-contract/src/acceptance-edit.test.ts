import { describe, expect, it } from 'bun:test';
import {
  acceptanceTestPaths, dropUnacceptedTestResults, flagAcceptanceEdit, acceptEdits, pendingAcceptance,
} from './acceptance-edit';

describe('acceptance-edit (R-80, AC-126)', () => {
  it('names the acceptance test files among a PR\'s paths, deletions included', () => {
    const files = [
      'apps/web/tests/integration/verdict-acceptance.test.ts',
      'packages/x/__tests__/acceptance/foo.test.ts',
      'apps/web/src/lib/acceptance-helper.ts',
      'apps/web/src/lib/specs/outcome.test.ts',
      'docs/acceptance.md',
    ];
    expect(acceptanceTestPaths(files)).toEqual([
      'apps/web/tests/integration/verdict-acceptance.test.ts',
      'packages/x/__tests__/acceptance/foo.test.ts',
    ]);
  });

  it('flags the edit, and only a person\'s acceptance clears it', () => {
    const flag = flagAcceptanceEdit(null, ['a.acceptance.test.ts'], 'abc1234', '2026-10-19T00:00:00Z');
    expect(pendingAcceptance(flag)).toEqual(['a.acceptance.test.ts']);
    const accepted = acceptEdits(flag, 'user:u1', '2026-10-19T01:00:00Z');
    expect(pendingAcceptance(accepted)).toEqual([]);
  });

  it('a later push that touches another acceptance test re-flags only the new one', () => {
    const accepted = acceptEdits(flagAcceptanceEdit(null, ['a.acceptance.test.ts'], 'abc1234', 't0'), 'user:u1', 't1');
    const next = flagAcceptanceEdit(accepted, ['a.acceptance.test.ts', 'b.acceptance.test.ts'], 'def5678', 't2');
    expect(pendingAcceptance(next)).toEqual(['b.acceptance.test.ts']);
  });

  it('a push that no longer edits any acceptance test clears the flag', () => {
    const flag = flagAcceptanceEdit(null, ['a.acceptance.test.ts'], 'abc1234', 't0');
    expect(flagAcceptanceEdit(flag, [], 'def5678', 't1')).toBeNull();
  });

  it('test results are not counted while an edit awaits acceptance; reviews still are', () => {
    const rows = [{ id: 1, source: 'test' as const }, { id: 2, source: 'review' as const }];
    const flag = flagAcceptanceEdit(null, ['a.acceptance.test.ts'], 'abc1234', 't0');
    expect(dropUnacceptedTestResults(rows, flag).map((r) => r.id)).toEqual([2]);
    expect(dropUnacceptedTestResults(rows, acceptEdits(flag, 'user:u1', 't1')).map((r) => r.id)).toEqual([1, 2]);
    expect(dropUnacceptedTestResults(rows, null).map((r) => r.id)).toEqual([1, 2]);
  });
});
