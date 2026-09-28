import { describe, it, expect } from 'bun:test';
import { describeExplicitDeferral, type DeferralReason } from './explicit-deferral';

// Friction cad81659: a named task deferred in the dispatch loop got "claimable
// but held back this poll" for every reason except path overlap. Each deferral
// key must name itself.
const ALL: DeferralReason[] = [
  'connector_mismatch', 'subject_dead', 'path_overlap', 'advisory_manifest',
  'mission_budget', 'mission_concurrent', 'mission_paced', 'workspace_cap',
  'provider_unavailable', 'budget_paused', 'routing_paused', 'duplicate_worker',
  'runner_capability', 'codex_single_flight', 'oauth_parallelism',
];

describe('describeExplicitDeferral', () => {
  it('names every deferral reason with its own code and a sentence', () => {
    for (const reason of ALL) {
      const r = describeExplicitDeferral(reason);
      expect(r.code).toBe(reason);
      expect(r.detail.length).toBeGreaterThan(10);
      expect(r.detail).not.toMatch(/unknown|does not cover/i);
    }
  });

  it('carries the numbers the loop had in hand', () => {
    expect(describeExplicitDeferral('mission_concurrent', { active: 3, cap: 3 }).detail).toContain('3/3');
    expect(describeExplicitDeferral('workspace_cap', { active: 4, cap: 3 }).detail).toContain('4/3');
    expect(describeExplicitDeferral('mission_paced', { nextEligibleAt: '2026-09-28T13:00:00.000Z' }).detail)
      .toContain('2026-09-28T13:00:00.000Z');
    expect(describeExplicitDeferral('advisory_manifest', { blockingPeer: 'peer-task' }).detail).toContain('peer-task');
    expect(describeExplicitDeferral('path_overlap', { blockingTaskId: 'blocker-1', prNumber: null }).detail).toContain('blocker-1');
    expect(describeExplicitDeferral('path_overlap', { prNumber: 12 }).detail).toContain('PR #12');
  });

  it('points at force: true only where the override actually applies', () => {
    for (const reason of ['mission_concurrent', 'mission_paced', 'workspace_cap', 'path_overlap'] as const) {
      expect(describeExplicitDeferral(reason).detail).toContain('force: true');
    }
    // Cost, scope serialization, capacity walls and routing are not overridable.
    for (const reason of ['mission_budget', 'advisory_manifest', 'budget_paused', 'codex_single_flight', 'runner_capability', 'provider_unavailable'] as const) {
      expect(describeExplicitDeferral(reason).detail).not.toContain('force: true');
    }
  });
});
