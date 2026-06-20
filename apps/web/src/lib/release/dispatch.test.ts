import { describe, it, expect } from 'bun:test';
import { classifyCheckRuns, type CheckRun } from './dispatch';

const run = (over: Partial<CheckRun> = {}): CheckRun => ({
  name: 'build',
  status: 'completed',
  conclusion: 'success',
  ...over,
});

describe('classifyCheckRuns', () => {
  it('is unknown with no checks', () => {
    expect(classifyCheckRuns([])).toEqual({ ciState: 'unknown', failingChecks: [] });
  });

  it('is pending while any check is incomplete', () => {
    const r = classifyCheckRuns([run(), run({ name: 'test', status: 'in_progress', conclusion: null })]);
    expect(r.ciState).toBe('pending');
  });

  it('is passing when all complete and successful', () => {
    expect(classifyCheckRuns([run(), run({ name: 'test' })]).ciState).toBe('passing');
  });

  it('treats neutral and skipped as non-failing', () => {
    const r = classifyCheckRuns([run({ conclusion: 'neutral' }), run({ name: 'lint', conclusion: 'skipped' })]);
    expect(r.ciState).toBe('passing');
  });

  it('is failing and names the failing checks', () => {
    const r = classifyCheckRuns([run(), run({ name: 'test', conclusion: 'failure' }), run({ name: 'e2e', conclusion: 'timed_out' })]);
    expect(r.ciState).toBe('failing');
    expect(r.failingChecks).toEqual(['test', 'e2e']);
  });
});
