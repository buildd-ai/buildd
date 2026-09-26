import { describe, test, expect } from 'bun:test';
import { buildLineage } from './pr-lineage';

const T = 10_000_000;
const s = (sec: number) => T + sec * 1000;

const attempt1 = { runner: 'cedar', roleName: 'Builder', commits: 4, add: 402, rem: 61, files: 11, createdAt: s(0), startedAt: s(3), completedAt: s(509), headSha: 'aaaaaaa1' };
const attempt2 = { runner: 'birch', roleName: 'Builder', commits: 1, add: 23, rem: 9, files: 2, createdAt: s(620), startedAt: s(623), completedAt: s(814), headSha: 'bbbbbbb2' };
const retry = { createdAt: s(620), headSha: 'aaaaaaa1', failure: { job: 'unit', test: 'packages/pdf/src/invoice.snapshot.test.tsx', excerpt: 'Expected "1.234,50 €"' } };

describe('buildLineage', () => {
  test('failed → retried → green → merged reads as one chain', () => {
    const l = buildLineage({ attempts: [attempt1, attempt2], retries: [retry], pr: { lifecycle: 'merged', mergedAt: s(834) } });
    expect(l.steps.map(x => x.kind)).toEqual(['attempt', 'ci_failed', 'retry', 'attempt', 'ci_green', 'merged']);
    expect(l.steps[0]).toMatchObject({ title: 'Attempt 1', sub: 'Builder on cedar · 4 commits, PR opened', at: '8:26' });
    expect(l.steps[1]).toMatchObject({ title: 'CI failed', sub: 'unit · invoice.snapshot.test.tsx', at: '1:51 after push' });
    expect(l.steps[2]).toMatchObject({ title: 'Retry sent', sub: 'Failure excerpt handed to a fresh builder' });
    expect(l.steps[3]).toMatchObject({ title: 'Attempt 2', sub: 'Builder on birch · 1 commit, same branch', at: '3:11' });
    expect(l.steps[5]).toMatchObject({ title: 'Merged', at: '+0:20' });
    expect(l.totals).toEqual({ add: 425, rem: 70, files: 13, commits: 5, attempts: 2, claimToMerge: '13:54' });
  });

  test('per-commit check rows: the retried head failed, the final head passed', () => {
    const l = buildLineage({ attempts: [attempt1, attempt2], retries: [retry], pr: { lifecycle: 'merged', mergedAt: s(834) } });
    expect(l.commits).toEqual([
      { attempt: 1, sha: 'aaaaaaa', ref: 'aaaaaaa1', state: 'failed', failure: retry.failure },
      { attempt: 2, sha: 'bbbbbbb', ref: 'bbbbbbb2', state: 'passed', failure: null },
    ]);
  });

  test('a single attempt with CI still running ends on a running step and has no merge time', () => {
    const l = buildLineage({ attempts: [attempt1], retries: [], pr: { lifecycle: 'ci_running', mergedAt: null } });
    expect(l.steps.map(x => x.kind)).toEqual(['attempt', 'ci_running']);
    expect(l.totals.claimToMerge).toBeNull();
    expect(l.commits).toEqual([{ attempt: 1, sha: 'aaaaaaa', ref: 'aaaaaaa1', state: 'running', failure: null }]);
  });

  test('a retry still running ends on its attempt, not on the earlier failure', () => {
    const l = buildLineage({
      attempts: [attempt1, { ...attempt2, completedAt: null, headSha: null }],
      retries: [retry],
      pr: { lifecycle: 'ci_failed', mergedAt: null },
    });
    expect(l.steps.map(x => x.kind)).toEqual(['attempt', 'ci_failed', 'retry', 'attempt']);
    expect(l.steps[3]).toMatchObject({ at: 'running' });
    expect(l.commits.map(c => c.state)).toEqual(['failed']);
  });

  test('a still-failing PR with no retry ends on ci_failed', () => {
    const l = buildLineage({ attempts: [attempt1], retries: [], pr: { lifecycle: 'ci_failed', mergedAt: null } });
    expect(l.steps.map(x => x.kind)).toEqual(['attempt', 'ci_failed']);
    expect(l.commits[0].state).toBe('failed');
  });

  test('missing runner/role/timestamps degrade without inventing values', () => {
    const l = buildLineage({
      attempts: [{ ...attempt1, runner: null, roleName: null, startedAt: null, completedAt: null }],
      retries: [],
      pr: { lifecycle: 'pr_open', mergedAt: null },
    });
    expect(l.steps[0]).toMatchObject({ sub: '4 commits, PR opened', at: null });
    expect(l.steps.map(x => x.kind)).toEqual(['attempt']);
  });
});
