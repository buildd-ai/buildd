/**
 * The mission's release status (spec f7f67f1a P-3, R-22, AC-9): what happened
 * to THIS mission's merged work after it left the mission. `deliveryReleaseInput`
 * only answers "how far do healthy releases reach" and is null for a deploy in
 * flight or failing, so on its own it hides exactly the states an owner needs.
 */
import { describe, expect, it } from 'bun:test';
import { missionReleaseStatus, type MissionReleaseStatusInput } from './mission-delivery';
import type { ReleaseState } from './release-state';

const MERGED = '2026-03-11T08:00:00.000Z';
const BEFORE = '2026-03-10T00:00:00.000Z';
const AFTER = '2026-03-12T00:00:00.000Z';

const continuous = (deployState: string, at: string | null = AFTER): ReleaseState => ({
  state: 'unseeded', archetype: 'continuous', seeded: deployState === 'healthy',
  deployState, deployedAt: at, healthyAt: deployState === 'healthy' ? at : null, releaseId: 'rel-1',
});
const gated = (baselineSource: 'healthy' | 'deployed' | 'dispatched' | 'prod_head' | 'none', baselineAsOf: string | null = AFTER): ReleaseState => ({
  state: 'unseeded', archetype: 'gated', seeded: baselineSource === 'healthy', baselineSource,
  queueDepth: 2, oldestMergedAt: null, releaseId: 'rel-1', baselineAsOf,
});
const status = (state: ReleaseState, over: Partial<MissionReleaseStatusInput> = {}) =>
  missionReleaseStatus({ state, mergedAt: [MERGED], releasedAt: null, ...over });

describe('missionReleaseStatus', () => {
  it('is not_configured when the workspace has no release flow', () => {
    expect(status({ state: 'none' })).toBe('not_configured');
    expect(status({ state: 'clean', reason: 'no_pipeline' })).toBe('not_configured');
  });

  it('is waiting while none of the mission is on trunk', () => {
    expect(status(continuous('healthy'), { mergedAt: [] })).toBe('waiting');
    expect(status(gated('healthy'), { mergedAt: [] })).toBe('waiting');
  });

  describe('continuous deploys', () => {
    it('is healthy only when a healthy deploy is at or after the last merge', () => {
      expect(status(continuous('healthy', AFTER))).toBe('healthy');
      expect(status(continuous('healthy', MERGED))).toBe('healthy');
    });

    it('is deploying while a deploy after the merge is in flight', () => {
      expect(status(continuous('deploying'))).toBe('deploying');
      expect(status(continuous('pending_external'))).toBe('deploying');
    });

    it('is dispatched while a dispatched deploy has not started', () => {
      expect(status(continuous('dispatched'))).toBe('dispatched');
    });

    it('is failed when the deploy after the merge failed or degraded', () => {
      expect(status(continuous('failed'))).toBe('failed');
      expect(status(continuous('degraded'))).toBe('failed');
    });

    it('counts a deploy with no time as covering the merge, so a failure is never hidden', () => {
      expect(status(continuous('failed', null))).toBe('failed');
    });

    it('ignores a deploy older than the merge: the work has not been deployed yet', () => {
      expect(status(continuous('failed', BEFORE))).toBe('waiting');
      expect(status(continuous('healthy', BEFORE))).toBe('waiting');
      expect(status(continuous('healthy', BEFORE), { releasedAt: AFTER })).toBe('dispatched');
    });

    it('is waiting when the workspace has never deployed', () => {
      expect(status({ state: 'clean', reason: 'no_deploy_state' })).toBe('waiting');
      expect(status({ state: 'clean', reason: 'no_deploy_state' }, { releasedAt: AFTER })).toBe('dispatched');
    });

    it('is unknown for a deploy state it does not recognise', () => {
      expect(status(continuous('rolled_back'))).toBe('unknown');
    });
  });

  describe('gated releases', () => {
    it('is healthy when a healthy release covers every merge', () => {
      expect(status(gated('healthy'))).toBe('healthy');
    });

    it('reads the rung that covers the merge: deployed is still deploying, dispatched is dispatched', () => {
      expect(status(gated('deployed'))).toBe('deploying');
      expect(status(gated('dispatched'))).toBe('dispatched');
    });

    it('is unknown when only the prod branch head covers the merge (no release record)', () => {
      expect(status(gated('prod_head'))).toBe('unknown');
    });

    it('is waiting when the baseline is older than the last merge', () => {
      expect(status(gated('healthy', BEFORE))).toBe('waiting');
      expect(status(gated('healthy', BEFORE), { releasedAt: AFTER })).toBe('dispatched');
    });

    it('judges the latest merge: one merge after the baseline means not yet released', () => {
      expect(status(gated('healthy', MERGED), { mergedAt: [BEFORE, AFTER] })).toBe('waiting');
    });

    it('a clean queue is healthy only when its baseline was a healthy release', () => {
      expect(status({ state: 'clean', reason: 'zero_queue', baselineSource: 'healthy' })).toBe('healthy');
      expect(status({ state: 'clean', reason: 'zero_queue', baselineSource: 'prod_head' })).toBe('unknown');
      expect(status({ state: 'clean', reason: 'zero_queue' })).toBe('unknown');
    });

    it('is unknown when no baseline resolved but the work is merged', () => {
      expect(status({ state: 'clean', reason: 'no_baseline' })).toBe('unknown');
    });
  });
});
