/**
 * Pause, policy and rollout (operator-recovery spec §8.3, §8.4, §9.5).
 */
import { describe, it, expect } from 'bun:test';
import {
  applyPolicyPatch, automationGate, buildAutomationState, DEFAULT_RECOVERY_POLICY, pauseFor, pauseKey,
  PAUSE_PLATFORM_KEY, POLICY_KEY, rulePolicy, type AutomationRow,
} from './failure-incident-recovery-automation';

const NOW = new Date('2026-10-11T12:00:00.000Z');
const later = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const row = (key: string, value: unknown, expiresAt: Date | null = null): AutomationRow => ({ key, value, updatedAt: new Date('2026-10-11T11:00:00.123Z'), expiresAt });
const CAUSE = 'c1:0123456789abcdef0123';

describe('pause keys', () => {
  it('one key per scope', () => {
    expect(pauseKey({ kind: 'platform' })).toBe('operator-recovery:pause:platform');
    expect(pauseKey({ kind: 'rule', rule: 'path_overlap_stall' })).toBe('operator-recovery:pause:rule:path_overlap_stall');
    expect(pauseKey({ kind: 'cause', causeKey: CAUSE })).toBe(`operator-recovery:pause:cause:${CAUSE}`);
    expect(pauseKey({ kind: 'model' })).toBe('operator-recovery:pause:model');
  });
});

describe('state: fail closed', () => {
  it('a failed read is paused everywhere, with readError', () => {
    const s = buildAutomationState(null, NOW);
    expect(s.readError).toBe(true);
    expect(s.paused.platform).toBe(true);
    expect(pauseFor(s, { rule: 'path_overlap_stall', causeKey: null })).toEqual({ kind: 'platform' });
    const g = automationGate(s, { rule: 'path_overlap_stall', causeKey: null, action: 'release_blocker', kind: 'release_blocker' });
    expect(g.run).toBe(false);
    if (!g.run) expect(g.label).toMatch(/could not be read/);
  });

  it('an expired pause lapses on its own; the revisions are the CAS tokens', () => {
    const s = buildAutomationState([row(PAUSE_PLATFORM_KEY, { until: NOW.toISOString() }, new Date(NOW.getTime() - 1))], NOW);
    expect(s.paused.platform).toBe(false);
    expect(s.revisions[PAUSE_PLATFORM_KEY]).toBeUndefined();
    const live = buildAutomationState([row(PAUSE_PLATFORM_KEY, { until: later(2).toISOString() }, later(2))], NOW);
    expect(live.paused.platform).toBe(true);
    expect(live.revisions[PAUSE_PLATFORM_KEY]).toBe('2026-10-11T11:00:00.123Z');
  });

  it('rule and cause pauses only hold their own scope', () => {
    const s = buildAutomationState([
      row(pauseKey({ kind: 'rule', rule: 'stranded_gate' }), {}, later(1)),
      row(pauseKey({ kind: 'cause', causeKey: CAUSE }), {}, later(1)),
    ], NOW);
    expect(pauseFor(s, { rule: 'stranded_gate', causeKey: null })).toEqual({ kind: 'rule', rule: 'stranded_gate' });
    expect(pauseFor(s, { rule: 'path_overlap_stall', causeKey: CAUSE })).toEqual({ kind: 'cause', causeKey: CAUSE });
    expect(pauseFor(s, { rule: 'path_overlap_stall', causeKey: 'c1:ffffffffffffffffffff' })).toBeNull();
  });
});

describe('rollout (§9.5): new repairs start in shadow', () => {
  const s = buildAutomationState([], NOW);
  it("FIR's shipped repairs keep running", () => {
    expect(automationGate(s, { rule: 'path_overlap_stall', causeKey: null, action: 'release_blocker', kind: 'release_blocker' }).run).toBe(true);
    expect(automationGate(s, { rule: 'infrastructure_failure', causeKey: null, action: 'retry_capture', kind: 'rerun_visual_audit' }).run).toBe(true);
  });
  it('a B2 repair records and runs nothing until set_policy turns it on', () => {
    const g = automationGate(s, { rule: 'repeated_failure', causeKey: null, action: 'redeliver_dispatch', kind: 'redeliver_dispatch' });
    expect(g).toMatchObject({ run: false, why: 'shadow' });
    const on = applyPolicyPatch(DEFAULT_RECOVERY_POLICY, { rule: 'repeated_failure', autoRepair: 'on', repair: { kind: 'redeliver_dispatch', mode: 'on' } });
    expect(on.ok).toBe(true);
    const s2 = buildAutomationState([row(POLICY_KEY, on.ok ? on.policy : null)], NOW);
    expect(automationGate(s2, { rule: 'repeated_failure', causeKey: null, action: 'redeliver_dispatch', kind: 'redeliver_dispatch' }).run).toBe(true);
  });
  it('a family switched off holds even its shipped repairs; the stricter switch wins', () => {
    const off = applyPolicyPatch(DEFAULT_RECOVERY_POLICY, { rule: 'path_overlap_stall', autoRepair: 'off' });
    const s3 = buildAutomationState([row(POLICY_KEY, off.ok ? off.policy : null)], NOW);
    expect(automationGate(s3, { rule: 'path_overlap_stall', causeKey: null, action: 'wake_subject', kind: 'wake_subject' })).toMatchObject({ run: false, why: 'off' });
  });
  it('an unknown family defaults to shadow', () => {
    expect(rulePolicy(DEFAULT_RECOVERY_POLICY, 'stranded_gate').autoRepair).toBe('shadow');
  });
});

describe('policy bounds (§8.4)', () => {
  const bad = (patch: Parameters<typeof applyPolicyPatch>[1]) => {
    const r = applyPolicyPatch(DEFAULT_RECOVERY_POLICY, patch);
    expect(r.ok).toBe(false);
  };
  it('refuses every value outside its bounds', () => {
    bad({ rule: 'path_overlap_stall', budgetLimit: 0 });
    bad({ rule: 'path_overlap_stall', budgetLimit: 6 });
    bad({ rule: 'path_overlap_stall', budgetLimit: 2.5 });
    bad({ rule: 'path_overlap_stall', backoffMinutes: [1, 15] });
    bad({ rule: 'path_overlap_stall', backoffMinutes: [5, 241] });
    bad({ rule: 'path_overlap_stall', backoffMinutes: [] });
    bad({ rule: 'path_overlap_stall', episodeDeadlineHours: 0.5 });
    bad({ rule: 'path_overlap_stall', episodeDeadlineHours: 49 });
    bad({ model: { dailyUsd: 26 } });
    bad({ model: { dailyCalls: 2001 } });
    bad({ model: { timeoutMs: 1999 } });
    bad({ model: { timeoutMs: 15001 } });
    bad({ budgetLimit: 3 }); // rule fields need a rule
  });
  it('applies values at the bounds and keeps the rest', () => {
    const r = applyPolicyPatch(DEFAULT_RECOVERY_POLICY, { rule: 'path_overlap_stall', budgetLimit: 5, episodeDeadlineHours: 48, backoffMinutes: [2, 240] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.policy.perRule.path_overlap_stall).toEqual({ budgetLimit: 5, backoffMinutes: [2, 240], episodeDeadlineHours: 48, autoRepair: 'on' });
    expect(r.policy.perRule.infrastructure_failure).toEqual(DEFAULT_RECOVERY_POLICY.perRule.infrastructure_failure);
    expect(r.policy.model).toEqual(DEFAULT_RECOVERY_POLICY.model);
  });
});
