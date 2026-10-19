/**
 * Kernel command budget (Living Spec "Fast at any size", spec 3ef37387): `attempt_ended` and
 * `observe_ci_failure` answered in 6-10 s on the control plane because the command ran its effect
 * drain inline (GitHub reads, the CI-log fetch that files the fix task). The drain is now collected
 * and run after the answer is stored (command-api.ts `DEFERRED_DRAIN_OPS`), so the command itself
 * is its reads, one transition statement and its projections.
 *
 * Counted with `recordNeonQueries`, the hook that labels production spans. Real kernel, real
 * Postgres, stateful fake GitHub.
 */
import { afterEach, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { recordNeonQueries } from '@buildd/core/db';
import { withDeferredEffectDrains } from '../../src/lib/workflow/effect-drain-context';
import { MAX_CI, seam, world, type World } from './workflow-scenarios-world';

setDefaultTimeout(60_000);

/** Round trips one command may spend before its answer. A regression names its query in the failure. */
const BUDGET = 45;

let w: World;
afterEach(() => w?.dispose());

const describeRec = (rec: Awaited<ReturnType<typeof recordNeonQueries>>) =>
  rec.queries.map(x => `${x.operation} ${x.table} [${x.head.slice(0, 70)}]`).join('\n');

describe('kernel command round trips', () => {
  test('attempt_ended: an owner end spends its reads and one transition, and defers the drain', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/budget-end', files: { 'src/a.ts': 'export const a = 2;\n' } });
    const task = { id: pr.ownerTaskId, workspaceId: w.workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'owner', context: null };
    let deferred!: Awaited<ReturnType<typeof withDeferredEffectDrains>>;
    const rec = await recordNeonQueries(async () => {
      deferred = await withDeferredEffectDrains(() => seam.attemptEnded({
        task, workerId: pr.workerId, status: 'completed', localHeadSha: pr.head, commitCount: 1, source: 'runner',
      }));
      return deferred.value;
    });
    expect(deferred.value.handled).toBe(true);
    expect({ overBudget: rec.count > BUDGET ? describeRec(rec) : null }).toEqual({ overBudget: null });
    // The review dispatch is an effect: it runs after the answer, not inside it.
    expect(deferred.drains.size).toBe(1);
    await Promise.all([...deferred.drains.values()].map(run => run()));
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');
  });

  test('observe_ci_failure: a red head records its transition and defers the fix task', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/budget-ci', files: { 'src/a.ts': 'export const a = 3;\n' } });
    await w.handOn(pr);
    w.gh.setCheck(w.repo, pr.head, 'build', { conclusion: 'failure' });
    let deferred!: Awaited<ReturnType<typeof withDeferredEffectDrains>>;
    const rec = await recordNeonQueries(async () => {
      deferred = await withDeferredEffectDrains(() => seam.observeCiFailure({
        workspaceId: w.workspaceId, repoFullName: w.repo, prNumber: pr.prNumber, installationId: w.installationId,
        headSha: pr.head, signature: 'ci_failed', maxAttempts: MAX_CI, source: 'webhook:check_suite',
      }));
      return deferred.value;
    });
    expect(deferred.value.handled).toBe(true);
    expect({ overBudget: rec.count > BUDGET ? describeRec(rec) : null }).toEqual({ overBudget: null });
    expect(deferred.drains.size).toBeGreaterThan(0);
    await Promise.all([...deferred.drains.values()].map(run => run()));
  });
});
