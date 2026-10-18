import { describe, expect, it } from 'bun:test';
import { claimBlockerKind, projectClaimBlocker, projectClaimBlockers } from './claim-blocker-projection';
import { DEFERRAL_FRESHNESS_MS } from './mission-claim-deferrals';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms);

describe('projectClaimBlocker (spec 97b1bd0b R-10)', () => {
  it('no recorded decision is unknown, never blocked', () => {
    expect(projectClaimBlocker(null, NOW)).toEqual({ state: 'unknown', kind: null, reason: null, phrase: null, evaluatedAt: null });
  });
  it('a fresh refusal is blocked and carries when it was evaluated', () => {
    const b = projectClaimBlocker({ reason: 'codex_single_flight', occurredAt: ago(60_000) }, NOW);
    expect(b.state).toBe('blocked');
    expect(b.phrase).toContain('Codex');
    expect(b.evaluatedAt).toBe(ago(60_000).toISOString());
  });
  it('an old refusal is stale, not blocked', () => {
    const b = projectClaimBlocker({ reason: 'workspace_cap', occurredAt: ago(DEFERRAL_FRESHNESS_MS + 1) }, NOW);
    expect(b.state).toBe('stale');
    expect(b.reason).toBe('workspace_cap');
  });
  it('an unrecognised reason keeps the state but has no phrase', () => {
    expect(projectClaimBlocker({ reason: 'made_up', occurredAt: ago(1000) }, NOW).phrase).toBeNull();
  });
  it('takes the newest row per task and gives unknown to tasks with none', () => {
    const m = projectClaimBlockers(['a', 'b'], [
      { taskId: 'a', reason: 'workspace_cap', occurredAt: ago(1000) },
      { taskId: 'a', reason: 'codex_single_flight', occurredAt: ago(5000) },
    ], NOW);
    expect(m.get('a')!.reason).toBe('workspace_cap');
    expect(m.get('b')!.state).toBe('unknown');
  });
});

describe('claimBlockerKind (spec 97b1bd0b AC-8)', () => {
  it('keeps credential, capacity and sandbox holds distinct', () => {
    expect(claimBlockerKind('no_personal_credential')).toBe('credential_unavailable');
    expect(claimBlockerKind('managed_runner_hours')).toBe('capacity_exhausted');
    expect(claimBlockerKind('isolation_unenforced')).toBe('sandbox');
    expect(claimBlockerKind('path_overlap')).toBe('other');
    expect(claimBlockerKind(null)).toBeNull();
  });
});
