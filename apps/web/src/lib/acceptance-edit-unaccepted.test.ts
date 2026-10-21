import { describe, expect, it } from 'bun:test';
import { unacceptedPathsOf } from './acceptance-edit-sync';

const ctx = (paths: string[], acceptedPaths: string[]) => ({ acceptanceEdit: { paths, headSha: 'abc1234', flaggedAt: 't', acceptedPaths } });

describe('unacceptedPathsOf', () => {
  it('counts building tasks whatever the role casing or padding', () => {
    const rows = [
      { roleSlug: 'Builder', context: ctx(['a.acceptance.test.ts'], []) },
      { roleSlug: ' BUILDER ', context: ctx(['b.acceptance.test.ts'], []) },
      { roleSlug: 'builder', context: ctx(['c.acceptance.test.ts'], []) },
    ];
    expect(unacceptedPathsOf(rows)).toEqual(['a.acceptance.test.ts', 'b.acceptance.test.ts', 'c.acceptance.test.ts']);
  });

  it('leaves out accepted paths and non-building roles', () => {
    const rows = [
      { roleSlug: 'Builder', context: ctx(['a.acceptance.test.ts', 'b.acceptance.test.ts'], ['a.acceptance.test.ts']) },
      { roleSlug: 'researcher', context: ctx(['x.acceptance.test.ts'], []) },
      { roleSlug: null, context: ctx(['y.acceptance.test.ts'], []) },
      { roleSlug: 'builder', context: null },
    ];
    expect(unacceptedPathsOf(rows)).toEqual(['b.acceptance.test.ts']);
  });
});
