/**
 * Integration: S1 of the workflow kernel test matrix (docs/specs/workflow-state-kernel.md §16)
 * against a live deployment.
 *
 * The same scenario runs end to end on real Postgres in apps/web/tests/db/workflow-matrix.test.ts.
 * This live case needs two things that do not exist yet:
 *   - a deployment running the kernel (it lives on the mission branch; the dev preview has none);
 *   - `explain` reading the delivery (DeliveryView, Slice A part 3, task 7ab4916f).
 *
 * Intended, once both exist (BUILDD_TEST_SERVER + BUILDD_API_KEY, see task-lifecycle.test.ts):
 *   1. open a PR from a task in a kernel-on workspace; let its owner attempt complete;
 *   2. request changes (request_pr_review → reviewer verdict request-changes);
 *   3. run the fix attempt so it commits locally and completes WITHOUT pushing:
 *      PATCH /api/workers/[id] status=completed answers 400 code delivery_not_advanced;
 *   4. end the attempt anyway (worker gone) and call explain { prNumber }:
 *      state AWAITING_PUSH, owner of next move platform (push_recovery), no review round 2.
 */
import { describe, test } from 'bun:test';

describe('workflow kernel S1 against a live deployment', () => {
  test.todo('S1: fix without push → 400 delivery_not_advanced, then explain shows AWAITING_PUSH (needs 7ab4916f and a kernel deployment)');
});
