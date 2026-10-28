import { describe, expect, it, mock } from 'bun:test';

/**
 * A mission's final verification also runs the selected revision's registered
 * `verify:` checks, through the coordinator an explicit request uses, with the
 * production store. Kept apart from mission-acceptance-checks.test.ts so that
 * acceptance file stays as written.
 */
const SHA = 'a'.repeat(40);
const STORE = { name: 'production store' };
let dispatched: unknown[] = [];
let registered: unknown[][] = [];
let available = true;
let registeredFails = false;
mock.module('./criterion-checks', () => ({
  dispatchCriterionChecks: async (input: unknown) => { dispatched.push(input); return { dispatched: 2 }; },
  settleFinishedCheckRuns: async () => ({ settled: 0, attempted: 0 }),
}));
mock.module('./registered-verification', () => ({ dispatchRegisteredVerification: async (input: unknown, deps: unknown) => {
  registered.push([input, deps]);
  if (registeredFails) throw new Error('store unavailable');
  return { results: [], coverage: [], refused: [] };
} }));
mock.module('./registered-verification-store', () => ({ registeredVerificationDeps: STORE }));
mock.module('./mission-outcome', () => ({ resolveMissionCheckTarget: async () => available ? ({ headSha: SHA, branch: 'dev' }) : null }));
const { runFinalAcceptanceChecks } = await import('./mission-acceptance-checks');

describe('final acceptance: registered verify checks', () => {
  it('runs nothing against an unknown target', async () => {
    dispatched = []; registered = []; available = false;
    await runFinalAcceptanceChecks('verification-task', 'mission');
    expect(registered).toEqual([]);
  });
  it('R-7: runs them through the shared coordinator and production store at the same integrated target', async () => {
    dispatched = []; registered = []; available = true; registeredFails = false;
    await runFinalAcceptanceChecks('verification-task', 'mission');
    expect(registered).toEqual([[{ taskId: 'verification-task', headSha: SHA }, STORE]]);
  });
  it('a registered-check failure never stops the command checks', async () => {
    dispatched = []; registered = []; available = true; registeredFails = true;
    await runFinalAcceptanceChecks('verification-task', 'mission');
    expect(dispatched).toHaveLength(1);
    registeredFails = false;
  });
});
