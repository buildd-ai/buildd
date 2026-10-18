/**
 * Merge holds (workflow-kernel-library.md §4) on the in-memory host, where the
 * clock can be moved: a held merge is retried by any drain once its wait runs
 * out (the floor), with no wake at all, and the wait doubles to its cap.
 */
import { describe, expect, test } from 'bun:test';
import { drainEffects } from './effects';
import { kernelEffectHandlers } from './handlers/index';
import { memoryHost } from './conformance/harness';
import { Delivery } from './conformance/scenarios';
import { FakeGithub, RecordingRails } from './memory/ports';
import { MERGE_HOLD_MAX_DELAY_MS, MERGE_HOLD_MIN_DELAY_MS, mergeHoldDelayMs } from './merge-hold';
import type { KernelPorts } from './ports';

describe('mergeHoldDelayMs', () => {
  test('starts at the minimum, grows with the hold, and never passes the cap', () => {
    expect(mergeHoldDelayMs(0)).toBe(MERGE_HOLD_MIN_DELAY_MS);
    expect(mergeHoldDelayMs(90_000)).toBe(90_000);
    expect(mergeHoldDelayMs(10 * MERGE_HOLD_MAX_DELAY_MS)).toBe(MERGE_HOLD_MAX_DELAY_MS);
  });
});

describe('a held merge on the floor', () => {
  test('a drain after the wait calls GitHub again, without any wake; the delivery stays LANDING throughout', async () => {
    const host = memoryHost();
    const s = await (await new Delivery(host, 7).open()).approvedAt('H1');
    await s.land('H1');
    const github = new FakeGithub();
    github.setPr(s.repo, s.prNumber, s.live('H1'));
    github.mergeAnswer = { outcome: 'held', check: 'build', detail: 'Required status check "build" is expected.' };
    const ports: KernelPorts = { store: host.store, github, clock: host.kernel.clock, policy: host.policy, rails: new RecordingRails() };
    const drain = () => drainEffects(host.store, { policy: host.policy, handlers: kernelEffectHandlers(ports), deliveryId: s.deliveryId, log: { log: () => {}, error: () => {} } });

    await drain();
    expect(github.merges.length).toBe(1);
    await drain();
    expect(github.merges.length).toBe(1);
    host.kernel.clock.advance(MERGE_HOLD_MIN_DELAY_MS);
    await drain();
    expect(github.merges.length).toBe(2);
    expect((await s.d()).state).toBe('LANDING');
  });
});

describe('MergeCallResult(held) in the reducer', () => {
  test('a hold that is not lasting leaves the approval standing; a lasting one escalates naming the check', async () => {
    const host = memoryHost();
    const a = await (await new Delivery(host, 8).open()).approvedAt('H1');
    await a.land('H1');
    const r = await a.submit({ type: 'MergeCallResult', actor: 'effect:merge_call', headSha: 'H1', outcome: 'held', hold: { check: 'build' }, landingVersion: (await a.d()).version });
    expect(r.result).toBe('applied');
    expect((await a.d()).state).toBe('APPROVED');

    const b = await (await new Delivery(host, 9).open()).approvedAt('H1');
    await b.land('H1');
    await b.submit({ type: 'MergeCallResult', actor: 'effect:merge_call', headSha: 'H1', outcome: 'held', hold: { check: 'build', lasting: true }, landingVersion: (await b.d()).version });
    expect((await b.d())).toMatchObject({ state: 'ESCALATED', stateReason: 'landing_needs_human' });
    const notify = host.kernel.effects(b.deliveryId, 'notify').at(-1)!;
    expect(String(notify.payload.detail)).toContain('required check "build"');
  });
});
