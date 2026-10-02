import { describe, expect, it } from 'bun:test';
import { buildCommitChecksView, sortRuns } from './commit-checks-view';
import type { CiCheckRun, PrCommitChecks } from './PrCard';

const pass = (name: string): CiCheckRun => ({ name, status: 'completed', conclusion: 'success', detailsUrl: `https://ci/${name}` });
const fail = (name: string): CiCheckRun => ({ name, status: 'completed', conclusion: 'failure', detailsUrl: `https://ci/${name}` });
const running = (name: string): CiCheckRun => ({ name, status: 'in_progress', conclusion: null, detailsUrl: null });

const commit = (attempt: number, runs: CiCheckRun[], over: Partial<PrCommitChecks> = {}): PrCommitChecks => ({
  attempt,
  sha: `abc${attempt}def`,
  state: runs.some(r => r.conclusion === 'failure') ? 'failed' : 'passed',
  failure: null,
  runs,
  ...over,
});

const NINE = Array.from({ length: 9 }, (_, i) => pass(`check ${i + 1}`));

describe('all passed', () => {
  it('collapses to one row: ✓ 9 checks passed', () => {
    const [v] = buildCommitChecksView([commit(1, NINE)]);
    expect(v.heading).toBe('Attempt 1 · abc1def');
    expect(v.summary).toBe('✓ 9 checks passed');
    expect(v.tone).toBe('success');
    expect(v.defaultOpen).toBe(false);
  });
});

describe('one failed', () => {
  it('opens, with the failure first', () => {
    const [v] = buildCommitChecksView([commit(1, [pass('lint'), fail('unit'), pass('build')])]);
    expect(v.defaultOpen).toBe(true);
    expect(v.summary).toBe('✗ 1 failed · 2 passed');
    expect(v.tone).toBe('error');
    expect(v.runs.map(r => r.name)).toEqual(['unit', 'lint', 'build']);
  });

  it('knows the failing job from the retry task when GitHub did not answer', () => {
    const [v] = buildCommitChecksView([commit(1, [], { runs: null, state: 'failed', failure: { job: 'Build' } })]);
    expect(v.runs.map(r => r.name)).toEqual(['Build']);
    expect(v.failed).toBe(1);
    expect(v.defaultOpen).toBe(true);
  });
});

describe('two attempts', () => {
  it('keeps an earlier failed attempt collapsed and a green latest collapsed', () => {
    const views = buildCommitChecksView([commit(1, [fail('unit'), pass('lint')]), commit(2, NINE)]);
    expect(views.map(v => v.defaultOpen)).toEqual([false, false]);
    expect(views[0].summary).toBe('✗ 1 failed · 1 passed');
    expect(views[1].summary).toBe('✓ 9 checks passed');
  });

  it('opens the latest only when it has failures', () => {
    const views = buildCommitChecksView([commit(1, [fail('unit')]), commit(2, [fail('e2e'), pass('lint')])]);
    expect(views.map(v => v.defaultOpen)).toEqual([false, true]);
  });
});

describe('ordering and running checks', () => {
  it('sorts failed, then running, then passed, stable within each', () => {
    const sorted = sortRuns([pass('a'), running('b'), fail('c'), pass('d'), fail('e')]);
    expect(sorted.map(r => r.name)).toEqual(['c', 'e', 'b', 'a', 'd']);
  });

  it('summarises running checks without opening', () => {
    const [v] = buildCommitChecksView([commit(1, [running('a'), pass('b')], { state: 'running' })]);
    expect(v.summary).toBe('… 1 running · 1 passed');
    expect(v.defaultOpen).toBe(false);
  });

  it('a single passing check is singular', () => {
    expect(buildCommitChecksView([commit(1, [pass('a')])])[0].summary).toBe('✓ 1 check passed');
  });

  it('says so when no checks were reported', () => {
    expect(buildCommitChecksView([commit(1, [], { runs: null, state: 'unknown' })])[0].summary).toBe('No checks reported');
  });
});
