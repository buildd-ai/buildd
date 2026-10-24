/**
 * The landing lane's tenure (eccb6687): a holder that keeps renewing still yields
 * once it has held the lane for LANE_MAX_TENURE_MS. Time-bound, so on the
 * in-memory store's clock; the Postgres twin is in
 * apps/web/tests/db/workflow-scenarios-lane.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { memoryHost } from './conformance/harness';
import { Delivery } from './conformance/scenarios';
import { acquireLaneOn, holdsLane, refreshTakesLane, LANE_HOLD_MS, LANE_MAX_TENURE_MS } from './landing-lane';

describe('landing lane tenure', () => {
  test('a holder renewing inside its lease yields at the tenure cap, and the waiter takes the lane', async () => {
    const host = memoryHost();
    const a = await (await new Delivery(host, 11).open()).approvedAt('A1');
    const b = await (await new Delivery(host, 12).open()).approvedAt('B1');
    const k = { repoFullName: a.repo, baseRef: 'dev' };
    expect(await acquireLaneOn(host.store, { ...k, deliveryId: a.deliveryId, headSha: 'A1' })).toEqual({ acquired: true });

    // A renews well inside each lease, as a holder that keeps getting refreshed does.
    const step = LANE_HOLD_MS / 2;
    for (let t = step; t < LANE_MAX_TENURE_MS; t += step) {
      host.kernel.clock.advance(step);
      expect(await acquireLaneOn(host.store, { ...k, deliveryId: a.deliveryId, headSha: 'A1' })).toEqual({ acquired: true });
      if (t + step < LANE_MAX_TENURE_MS) expect((await acquireLaneOn(host.store, { ...k, deliveryId: b.deliveryId, headSha: 'B1' })).acquired).toBe(false);
    }
    host.kernel.clock.advance(step);
    // Renewing again does not restart its tenure while its lease runs.
    await acquireLaneOn(host.store, { ...k, deliveryId: a.deliveryId, headSha: 'A1' });
    expect(await host.store.laneHolder(k)).toBeNull();
    expect(await acquireLaneOn(host.store, { ...k, deliveryId: b.deliveryId, headSha: 'B1' })).toEqual({ acquired: true });
    expect(await host.store.laneHolder(k)).toEqual({ deliveryId: b.deliveryId, prNumber: 12 });
  });

  test('a holder whose lease ran out starts a fresh tenure when it takes the lane again', async () => {
    const host = memoryHost();
    const a = await (await new Delivery(host, 11).open()).approvedAt('A1');
    const k = { repoFullName: a.repo, baseRef: 'dev' };
    await acquireLaneOn(host.store, { ...k, deliveryId: a.deliveryId, headSha: 'A1' });
    host.kernel.clock.advance(LANE_MAX_TENURE_MS * 2);
    expect(await acquireLaneOn(host.store, { ...k, deliveryId: a.deliveryId, headSha: 'A1' })).toEqual({ acquired: true });
    expect(await host.store.laneHolder(k)).toEqual({ deliveryId: a.deliveryId, prNumber: 11 });
  });

  test('red at its head is not holding; red at an older head is', () => {
    const d = { state: 'APPROVED', stateReason: null, currentHeadSha: 'H2' };
    expect(holdsLane({ ...d, ci: 'red', ciHeadSha: 'H2' })).toBe(false);
    expect(holdsLane({ ...d, ci: 'red', ciHeadSha: 'H1' })).toBe(true);
    expect(holdsLane({ ...d, ci: null, ciHeadSha: null })).toBe(true);
    expect(holdsLane({ state: 'REPAIRING', stateReason: 'ci', currentHeadSha: 'H2', ci: 'red', ciHeadSha: 'H2' })).toBe(false);
  });

  test('a CI fix in flight is not holding, and its refresh goes beside the lane', () => {
    // T10 rejects a red reading while a CI attempt is open, so the delivery itself may read nothing red.
    const d = { state: 'APPROVED', stateReason: null, currentHeadSha: 'H2', ci: null, ciHeadSha: null };
    expect(holdsLane(d, [{ family: 'ci', status: 'running' }])).toBe(false);
    expect(holdsLane(d, [{ family: 'ci', status: 'queued' }])).toBe(false);
    expect(holdsLane(d, [{ family: 'ci', status: 'ended' }, { family: 'conflict', status: 'queued' }])).toBe(true);
    expect(refreshTakesLane(d, [{ family: 'ci', status: 'running' }])).toBe(false);
    expect(refreshTakesLane({ ...d, ci: 'red', ciHeadSha: 'H2' })).toBe(false);
    expect(refreshTakesLane({ ...d, ci: 'red', ciHeadSha: 'H1' })).toBe(true);
    expect(refreshTakesLane(d)).toBe(true);
  });

  test('the holder opening a CI fix yields the lane to the waiter, inside its lease and tenure', async () => {
    const host = memoryHost();
    const a = await (await new Delivery(host, 11).open()).approvedAt('A1');
    const b = await (await new Delivery(host, 12).open()).approvedAt('B1');
    const k = { repoFullName: a.repo, baseRef: 'dev' };
    await acquireLaneOn(host.store, { ...k, deliveryId: a.deliveryId, headSha: 'A1' });
    expect((await acquireLaneOn(host.store, { ...k, deliveryId: b.deliveryId, headSha: 'B1' })).acquired).toBe(false);
    host.kernel.store.attempts.push({
      id: 'fix-a', deliveryId: a.deliveryId, family: 'ci', attemptNo: 1, mode: 'agent', boundHeadSha: 'A1', triggerReason: null,
      taskId: null, status: 'running', outcome: null, maxAttempts: 3, reportedShas: [], pushedHeadSha: null,
    });
    expect(await host.store.laneHolder(k)).toBeNull();
    expect(await acquireLaneOn(host.store, { ...k, deliveryId: b.deliveryId, headSha: 'B1' })).toEqual({ acquired: true });
  });
});
