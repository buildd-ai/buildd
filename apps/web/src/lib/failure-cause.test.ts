import { describe, expect, it } from 'bun:test';
import { failureCause } from './failure-cause';

describe('failureCause (Navigation R-20: `Failed · <what to change>`)', () => {
  it('names a known failure in words', () => {
    expect(failureCause('Missing acceptance test: tests/acceptance/wsl2-setup.test.ts')).toBe('test file not found');
    expect(failureCause('error: Script not found "complete-task"')).toBe('script not found');
    expect(failureCause('Agent timed out after 30m with no output')).toBe('timed out');
    expect(failureCause('CONFLICT (content): Merge conflict in apps/web/src/lib/x.ts')).toBe('merge conflict');
    expect(failureCause('AssertionError: expected 2 to be 3')).toBe('tests failed');
  });
  it('otherwise the first line of the error, with no ids or hashes, clipped', () => {
    expect(failureCause('Grader returned no verdict for 5cdb81a3-12b7-4de0-a377-f21fd1c8d0ce at a0f8892e\nstack…')).toBe('grader returned no verdict');
    const long = failureCause('The agent could not find the setup script it was asked to change and stopped before editing anything at all');
    expect(long!.length).toBeLessThanOrEqual(60);
    expect(long!.endsWith('…')).toBe(true);
  });
  it('nothing to read is no cause', () => {
    expect(failureCause(null)).toBeNull();
    expect(failureCause('   ')).toBeNull();
  });
});
