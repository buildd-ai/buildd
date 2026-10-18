import { describe, it, expect } from 'bun:test';
import { stepsToRun } from './use-cloud-runner-deploy';

describe('stepsToRun', () => {
  it('runs only check on a no-op redeploy', () => {
    expect(stepsToRun(['bucket', 'worker', 'containers', 'connect'])).toEqual(['check']);
  });

  it('runs the steps check did not report current, in order', () => {
    expect(stepsToRun(['bucket', 'connect'])).toEqual(['check', 'worker', 'containers']);
  });

  it('runs every step when check reports nothing (a first deploy, or an older server)', () => {
    expect(stepsToRun(undefined)).toEqual(['check', 'bucket', 'worker', 'containers', 'connect']);
    expect(stepsToRun([])).toEqual(['check', 'bucket', 'worker', 'containers', 'connect']);
  });

  it('never skips check', () => {
    expect(stepsToRun(['check'])).toContain('check');
  });
});
