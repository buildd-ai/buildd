import { describe, it, expect, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@buildd/core/db/schema', () => ({ tasks: { id: 'id' } }));

const { reportTaskPolicyOutcome } = await import('./model-policy-outcomes');

const cfg = { endpoint: 'https://policy.example', token: 't'.repeat(32) };

describe('reportTaskPolicyOutcome', () => {
  it('does nothing, not even a DB read, when no policy service is configured', async () => {
    const loadContext = mock(async () => ({}));
    const report = mock(async () => ({ reported: true }));
    const ok = await reportTaskPolicyOutcome('t1', [{ type: 'merged', merged: true }], { configured: () => null, loadContext, report });
    expect(ok).toBe(false);
    expect(loadContext).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it('skips a missing task and an empty observation list', async () => {
    const loadContext = mock(async () => ({}));
    const report = mock(async () => ({ reported: true }));
    const deps = { configured: () => cfg, loadContext, report };
    expect(await reportTaskPolicyOutcome(null, [{ type: 'merged', merged: true }], deps)).toBe(false);
    expect(await reportTaskPolicyOutcome('t1', [], deps)).toBe(false);
    expect(loadContext).not.toHaveBeenCalled();
  });

  it('reports the observations against the task\'s stored context', async () => {
    const context = { resolvedTier: { policy: { version: 'v', planId: 'p', source: 'tier', surface: 'coding' } } };
    const report = mock(async () => ({ reported: true }));
    const ok = await reportTaskPolicyOutcome('t1', [{ type: 'tests', passed: true }], {
      configured: () => cfg, loadContext: async () => context, report,
    });
    expect(ok).toBe(true);
    expect(report).toHaveBeenCalledWith(context, [{ type: 'tests', passed: true }]);
  });

  it('never throws', async () => {
    const ok = await reportTaskPolicyOutcome('t1', [{ type: 'tests', passed: true }], {
      configured: () => cfg, loadContext: async () => { throw new Error('db down'); }, report: async () => ({ reported: true }),
    });
    expect(ok).toBe(false);
  });
});
