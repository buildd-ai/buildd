import { describe, expect, it } from 'bun:test';
import { projectClaimBlocker, projectClaimBlockers } from './claim-blocker-projection';
import { DEFERRAL_FRESHNESS_MS } from './mission-claim-deferrals';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms);

describe('projectClaimBlocker (spec 97b1bd0b R-10)', () => {
  it('no recorded decision is unknown, never blocked', () => {
    expect(projectClaimBlocker(null, NOW)).toEqual({ state: 'unknown', reason: null, phrase: null, evaluatedAt: null });
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
  it('a Codex-only refusal is stale once the task routes to Claude (AC-7)', () => {
    const b = projectClaimBlocker({ reason: 'codex_single_flight', occurredAt: ago(1000) }, NOW, 'claude');
    expect(b.state).toBe('stale');
    expect(b.reason).toBe('codex_single_flight');
  });
  it('a Codex-only refusal stays blocked while the task still routes to Codex', () => {
    expect(projectClaimBlocker({ reason: 'codex_single_flight', occurredAt: ago(1000) }, NOW, 'codex').state).toBe('blocked');
  });
  it('a backend-neutral refusal is unaffected by the effective backend', () => {
    expect(projectClaimBlocker({ reason: 'workspace_cap', occurredAt: ago(1000) }, NOW, 'claude').state).toBe('blocked');
  });
  it('projectClaimBlockers applies each task\'s effective backend', () => {
    const m = projectClaimBlockers(['a', 'b'], [
      { taskId: 'a', reason: 'codex_single_flight', occurredAt: ago(1000) },
      { taskId: 'b', reason: 'codex_single_flight', occurredAt: ago(1000) },
    ], NOW, new Map([['a', 'claude'], ['b', 'codex']]));
    expect(m.get('a')!.state).toBe('stale');
    expect(m.get('b')!.state).toBe('blocked');
  });
});
