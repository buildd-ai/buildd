import { describe, expect, it } from 'bun:test';
import { acceptanceHolds } from './acceptance-edit-holds';

const flag = (paths: string[], accepted: string[] = []) => ({ acceptanceEdit: { paths, headSha: 'abc1234', flaggedAt: '2026-10-27T00:00:00Z', acceptedPaths: accepted } });

describe('acceptanceHolds', () => {
  const prs = new Map([['t1', { prNumber: 5709, prUrl: 'https://github.com/o/r/pull/5709' }], ['t2', { prNumber: 5708, prUrl: 'https://github.com/o/r/pull/5708/' }]]);
  it('lists one row per flagged building task, with its PR, files and diff link', () => {
    const out = acceptanceHolds([
      { id: 't1', roleSlug: 'builder', context: flag(['tests/acceptance/a.test.ts']) },
      { id: 't2', roleSlug: 'builder', context: flag(['x/acceptance.test.ts', 'y/acceptance.test.ts'], ['y/acceptance.test.ts']) },
    ], prs);
    expect(out).toEqual([
      { taskId: 't2', prNumber: 5708, diffUrl: 'https://github.com/o/r/pull/5708/files', paths: ['x/acceptance.test.ts'], weakened: [] },
      { taskId: 't1', prNumber: 5709, diffUrl: 'https://github.com/o/r/pull/5709/files', paths: ['tests/acceptance/a.test.ts'], weakened: [] },
    ]);
  });
  it('skips accepted edits, non-building tasks and tasks without a flag', () => {
    expect(acceptanceHolds([
      { id: 't1', roleSlug: 'builder', context: flag(['a/acceptance.test.ts'], ['a/acceptance.test.ts']) },
      { id: 't2', roleSlug: 'researcher', context: flag(['a/acceptance.test.ts']) },
      { id: 't3', roleSlug: 'builder', context: {} },
    ], prs)).toEqual([]);
  });
  it('carries what got weaker, only for paths still waiting', () => {
    const check = (path: string, verdict: string, autoAccepted: boolean, weakened: string[]) => ({ path, verdict, headSha: 'abc1234', autoAccepted, weakened, stricter: [] });
    const [hold] = acceptanceHolds([{ id: 't1', roleSlug: 'builder', context: { acceptanceEdit: {
      paths: ['a/acceptance.test.ts', 'b/acceptance.test.ts', 'c/acceptance.test.ts'], headSha: 'abc1234', flaggedAt: 't', acceptedPaths: ['c/acceptance.test.ts'],
      checks: [
        check('a/acceptance.test.ts', 'loosened', false, ['The test "x" was removed']),
        check('b/acceptance.test.ts', 'unparseable', false, []),
        check('c/acceptance.test.ts', 'stricter', true, []),
      ],
    } } }], prs);
    expect(hold!.weakened).toEqual([
      { path: 'a/acceptance.test.ts', text: 'The test "x" was removed' },
      { path: 'b/acceptance.test.ts', text: 'Could not read this file, so it was not checked.' },
    ]);
  });
});
