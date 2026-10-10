import { describe, it, expect } from 'bun:test';
import { describeExplicitDeferral, type DeferralReason } from './explicit-deferral';

// Friction cad81659: a named task deferred in the dispatch loop got "claimable
// but held back this poll" for every reason except path overlap. Each deferral
// key must name itself.
const ALL: DeferralReason[] = [
  'connector_mismatch', 'subject_dead', 'path_overlap', 'advisory_manifest',
  'mission_budget', 'mission_concurrent', 'mission_paced', 'workspace_cap',
  'provider_unavailable', 'budget_paused', 'routing_paused', 'duplicate_worker',
  'runner_capability', 'codex_single_flight', 'oauth_parallelism', 'role_env_unsatisfied',
  'managed_concurrency', 'managed_runner_hours', 'hosted_runner_hours', 'no_personal_credential',
  'tier_policy',
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

  it('names which wall held a named task and when it lifts', () => {
    const seat = describeExplicitDeferral('budget_paused', { backend: 'claude', wall: 'account_seat', resetsAt: '2099-01-01T20:00:00.000Z' }).detail;
    expect(seat).toContain("The account's Claude session limit is reached");
    expect(seat).toContain('Jan 1, 20:00 UTC');
    const pause = describeExplicitDeferral('budget_paused', { backend: 'codex', wall: 'provider_pause', resetsAt: '2099-01-01T20:00:00.000Z' }).detail;
    expect(pause).toContain('Codex rate limit');
    expect(pause).toContain('no provider to fail over to');
    // Without a wall it still says the provider and the time.
    const bare = describeExplicitDeferral('budget_paused', { backend: 'claude', resetsAt: '2099-01-01T20:00:00.000Z' }).detail;
    expect(bare).toContain('claude');
    expect(bare).toContain('2099-01-01T20:00:00.000Z');
  });

  it('says the hosted runner allowance is used, with the numbers and the way out', () => {
    const d = describeExplicitDeferral('hosted_runner_hours', { used: 50, limit: 50, resetsAt: '2026-11-01T00:00:00.000Z' }).detail;
    expect(d).toContain('Hosted runner allowance used');
    expect(d).toContain('50 of 50');
    expect(d).toContain('2026-11-01T00:00:00.000Z');
    expect(d).toContain('runner of your own');
  });

  it('says why a personal-keys-only task was not claimed, and what to do', () => {
    const none = describeExplicitDeferral('no_personal_credential', { cause: 'no_requester', surface: 'agent-claude' }).detail;
    expect(none).toContain('personal keys only');
    expect(none).toContain('not started by a person');
    const noKey = describeExplicitDeferral('no_personal_credential', { cause: 'requester_has_no_key', surface: 'agent-codex' }).detail;
    expect(noKey).toContain('their own OpenAI API key');
    expect(describeExplicitDeferral('no_personal_credential', { cause: 'runner_lacks_feature' }).detail).toContain('updated runner');
  });

  it('carries the numbers the loop had in hand', () => {
    expect(describeExplicitDeferral('mission_concurrent', { active: 3, cap: 3 }).detail).toContain('3/3');
    expect(describeExplicitDeferral('workspace_cap', { active: 4, cap: 3 }).detail).toContain('4/3');
    expect(describeExplicitDeferral('mission_paced', { nextEligibleAt: '2026-09-28T13:00:00.000Z' }).detail)
      .toContain('2026-09-28T13:00:00.000Z');
    expect(describeExplicitDeferral('advisory_manifest', { blockingPeer: 'peer-task' }).detail).toContain('peer-task');
    expect(describeExplicitDeferral('path_overlap', { blockingTaskId: 'blocker-1', prNumber: null }).detail).toContain('blocker-1');
    expect(describeExplicitDeferral('path_overlap', { prNumber: 12 }).detail).toContain('PR #12');
    const env = describeExplicitDeferral('role_env_unsatisfied', { roleSlug: 'mailer', missing: ['A_KEY', 'B_ID'] }).detail;
    expect(env).toContain('mailer');
    expect(env).toContain('A_KEY, B_ID');
    expect(env).toContain('role_env_secret');
  });

  it('points at force: true only where the override actually applies', () => {
    for (const reason of ['mission_concurrent', 'mission_paced', 'workspace_cap', 'path_overlap'] as const) {
      expect(describeExplicitDeferral(reason).detail).toContain('force: true');
    }
    // Cost, scope serialization, capacity walls and routing are not overridable.
    for (const reason of ['mission_budget', 'advisory_manifest', 'budget_paused', 'codex_single_flight', 'runner_capability', 'provider_unavailable', 'role_env_unsatisfied'] as const) {
      expect(describeExplicitDeferral(reason).detail).not.toContain('force: true');
    }
  });
});
