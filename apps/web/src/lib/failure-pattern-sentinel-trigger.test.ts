import { afterEach, describe, expect, it, mock } from 'bun:test';

const scheduled: Array<() => unknown> = [];
let afterShouldThrow = false;
mock.module('next/server', () => ({
  after: (cb: () => unknown) => {
    if (afterShouldThrow) throw new Error('no request scope');
    scheduled.push(cb);
  },
}));

const { scheduleFailurePatternSentinel } = await import('./failure-pattern-sentinel-trigger');

afterEach(() => { scheduled.length = 0; afterShouldThrow = false; });

describe('scheduleFailurePatternSentinel', () => {
  it('is a no-op for a missing workspaceId — never schedules anything', () => {
    scheduleFailurePatternSentinel(null, { force: true });
    scheduleFailurePatternSentinel(undefined, { force: true });
    expect(scheduled).toHaveLength(0);
  });

  it('is inert under the test runner by default, so it cannot clobber another route test\'s db spy', () => {
    scheduleFailurePatternSentinel('00000000-0000-4000-8000-000000000009');
    expect(scheduled).toHaveLength(0);
  });

  it('defers via after() when a request scope exists', () => {
    scheduleFailurePatternSentinel('00000000-0000-4000-8000-000000000001', { force: true });
    expect(scheduled).toHaveLength(1);
  });

  it('never throws back at the caller, even when the deferred work fails internally (no DB in this test env)', async () => {
    scheduleFailurePatternSentinel('00000000-0000-4000-8000-000000000002', { force: true });
    const cb = scheduled.pop();
    expect(cb).toBeDefined();
    await expect(cb!()).resolves.toBeUndefined();
  });

  it('falls back to running immediately, without throwing, when after() has no request scope', () => {
    afterShouldThrow = true;
    expect(() => scheduleFailurePatternSentinel('00000000-0000-4000-8000-000000000003', { force: true })).not.toThrow();
    expect(scheduled).toHaveLength(0); // after() never got to push — ran detached instead
  });
});
