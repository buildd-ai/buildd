import { describe, expect, it } from 'bun:test';
import { dependencyFailedResult } from '@buildd/core/dependency-failure';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';
import { cleanUpSupersededFailures, planSupersededCleanup, type CleanupDependent, type CleanupDeps } from './mission-cleanup';

const STEP1 = 'step-1-failed';
const STEP1B = 'step-1-replacement';
const AUDIT = 'surface-audit';
const LATER = 'step-2';

const audit = (over: Partial<CleanupDependent> = {}): CleanupDependent => ({
  id: AUDIT, status: 'failed', dependsOn: [STEP1, LATER], roleSlug: VISUAL_AUDITOR_ROLE_SLUG, ran: false,
  result: dependencyFailedResult({ id: STEP1, title: 'Step 1' }), ...over,
});

function fakeDeps(replacements: Map<string, string>, dependents: CleanupDependent[], opts: { stillFailed?: boolean } = {}) {
  const log = { cancelled: [] as unknown[][], repointed: [] as unknown[], woke: [] as string[] };
  const deps: CleanupDeps = {
    replacementsOf: async () => replacements,
    dependentsOf: async () => dependents,
    cancelSuperseded: async (...a) => { if (opts.stillFailed === false) return false; log.cancelled.push(a); return true; },
    repoint: async (r) => { log.repointed.push(r); return true; },
    wake: async (id) => { log.woke.push(id); },
  };
  return { deps, log };
}

describe('cleanup before repair', () => {
  it('a failed task with a completed replacement is cancelled and its dependents re-pointed', async () => {
    const pending: CleanupDependent = { id: LATER, status: 'pending', dependsOn: [STEP1], roleSlug: null, ran: false, result: null };
    const { deps, log } = fakeDeps(new Map([[STEP1, STEP1B]]), [audit(), pending]);
    const r = await cleanUpSupersededFailures('m', 'ws', 'final-verification:fv', deps);
    expect(log.cancelled).toEqual([[STEP1, STEP1B, 'final-verification:fv']]);
    expect(r.cancelled).toEqual([{ taskId: STEP1, replacementId: STEP1B }]);
    expect(log.repointed).toEqual([
      // The audit the cascade failed for step 1 never ran: it goes back to the queue, waiting on the replacement.
      { taskId: AUDIT, from: [STEP1], dependsOn: [STEP1B, LATER], reopen: true, wake: true },
      { taskId: LATER, from: [STEP1], dependsOn: [STEP1B], reopen: false, wake: true },
    ]);
    expect(log.woke).toEqual([AUDIT, LATER]);
  });

  it('changes nothing when no failure has a completed replacement', async () => {
    const { deps, log } = fakeDeps(new Map(), [audit()]);
    expect(await cleanUpSupersededFailures('m', 'ws', 'x', deps)).toEqual({ cancelled: [], repointed: [] });
    expect(log.repointed).toEqual([]);
  });

  it('leaves the edges alone when the failed task was retried or cancelled meanwhile', async () => {
    const { deps, log } = fakeDeps(new Map([[STEP1, STEP1B]]), [audit()], { stillFailed: false });
    expect((await cleanUpSupersededFailures('m', 'ws', 'x', deps)).repointed).toEqual([]);
    expect(log.repointed).toEqual([]);
  });

  it('a builder the cascade failed is re-pointed but not reopened: a replacement may exist for it too', () => {
    const plan = planSupersededCleanup(new Map([[STEP1, STEP1B]]), [audit({ roleSlug: 'builder' })]);
    expect(plan.repoint[0]).toMatchObject({ reopen: false, wake: false });
  });

  it('an audit that ran and failed on its own is not reopened, and an edge never points a task at itself', () => {
    const plan = planSupersededCleanup(new Map([[STEP1, STEP1B]]), [audit({ ran: true }), { id: STEP1B, status: 'completed', dependsOn: [STEP1], roleSlug: null, ran: true, result: null }]);
    expect(plan.repoint.map((r) => [r.taskId, r.dependsOn, r.reopen])).toEqual([[AUDIT, [STEP1B, LATER], false], [STEP1B, [], false]]);
  });
});
