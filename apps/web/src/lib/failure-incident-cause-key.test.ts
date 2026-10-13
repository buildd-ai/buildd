import { describe, it, expect } from 'bun:test';
import type { FailureIncidentRule } from '@buildd/shared';
import {
  causeDiscriminator, causeScope, effectiveCauseKey, nextCauseGroup, ruleCauseKey,
} from './failure-incident-cause-key';

const WS_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const WS_B = 'bbbbbbbb-0000-4000-8000-000000000002';

const inc = (rule: FailureIncidentRule, signature: string, workspaceId: string | null, reasonCode = 'x.y', recovery: any = null) =>
  ({ rule, signature, workspaceId, reasonCode, recovery, impact: {} });

describe('causeKey', () => {
  it('is c1: plus 20 hex', () => {
    expect(ruleCauseKey(inc('repeated_failure', `repeated_failure|ws=${WS_A}|scrub-immutable-abc`, WS_A))).toMatch(/^c1:[0-9a-f]{20}$/);
  });

  it('groups a platform error family across workspaces and teams (one cause, not N)', () => {
    const a = ruleCauseKey(inc('repeated_failure', `repeated_failure|ws=${WS_A}|scrub-immutable-abc`, WS_A, 'repeated_failure.same_signature'));
    const b = ruleCauseKey(inc('repeated_failure', `repeated_failure|ws=${WS_B}|scrub-immutable-abc`, WS_B, 'repeated_failure.same_signature'));
    expect(a).toBe(b);
  });

  it('keeps a path-overlap blocker in its own workspace', () => {
    const a = ruleCauseKey(inc('path_overlap_stall', `path_overlap_stall|ws=${WS_A}|blocker=pr:12`, WS_A));
    const b = ruleCauseKey(inc('path_overlap_stall', `path_overlap_stall|ws=${WS_B}|blocker=pr:12`, WS_B));
    expect(a).not.toBe(b);
    expect(causeScope({ rule: 'path_overlap_stall', workspaceId: WS_A })).toBe(`ws:${WS_A}`);
  });

  it('a different error family is a different cause', () => {
    expect(ruleCauseKey(inc('repeated_failure', `repeated_failure|ws=${WS_A}|fam-one`, WS_A)))
      .not.toBe(ruleCauseKey(inc('repeated_failure', `repeated_failure|ws=${WS_A}|fam-two`, WS_A)));
  });

  it('uses the assessed cause code; a new code is a new cause', () => {
    const base = inc('path_overlap_stall', `path_overlap_stall|ws=${WS_A}|blocker=pr:12`, WS_A, 'path_overlap.no_progress');
    const assessed = { ...base, recovery: { cause: { reasonCode: 'path_overlap.cycle' } } };
    expect(ruleCauseKey(assessed)).not.toBe(ruleCauseKey(base));
  });

  it('is stable across generation and detector version (neither is an input)', () => {
    const a = inc('stranded_gate', `stranded_gate|ws=${WS_A}|gate=merge_policy|fric-1`, WS_A);
    expect(ruleCauseKey({ ...a, recovery: { cause: { reasonCode: 'x.y' }, generation: 1 } }))
      .toBe(ruleCauseKey({ ...a, recovery: { cause: { reasonCode: 'x.y' }, generation: 7 } }));
  });
});

describe('causeDiscriminator', () => {
  it('normalises each family and never keys on the workspace', () => {
    expect(causeDiscriminator('path_overlap_stall', `path_overlap_stall|ws=${WS_A}|blocker=pr:12`)).toBe('blocker=pr:12');
    expect(causeDiscriminator('stranded_gate', `stranded_gate|ws=${WS_A}|gate=merge_policy|fric-1`)).toBe('gate=merge_policy|reason=fric-1');
    expect(causeDiscriminator('repeated_failure', 'repeated_failure|ws=none|sentinel_self_health_degraded')).toBe('sentinel_self_health_degraded');
    expect(causeDiscriminator('failure_rate_spike', `failure_rate_spike|ws=${WS_A}`)).toBe('spike');
    expect(causeDiscriminator('output_unmet_boundary', `output_unmet_boundary|ws=${WS_A}|boundary=pr`)).toBe('boundary=pr');
  });
});

describe('cause membership', () => {
  const NOW = '2026-10-11T12:00:00.000Z';
  it('writes a rule membership when there is none', () => {
    expect(nextCauseGroup(undefined, 'c1:aaaa', NOW)).toEqual({ key: 'c1:aaaa', source: 'rule', decisionId: null, confidence: null, assignedAt: NOW, ruleKey: 'c1:aaaa' });
  });

  it('keeps an operator regroup while the rule key holds, and drops it when the cause code changes', () => {
    const op = { key: 'c1:merged', source: 'operator' as const, decisionId: 'audit-1', confidence: null, assignedAt: NOW, ruleKey: 'c1:aaaa' };
    expect(nextCauseGroup(op, 'c1:aaaa', NOW)).toEqual(op);
    expect(nextCauseGroup(op, 'c1:bbbb', NOW).source).toBe('rule');
  });

  it('groups by an operator membership and by a live model merge', () => {
    const base = inc('repeated_failure', `repeated_failure|ws=${WS_A}|fam`, WS_A);
    const rule = ruleCauseKey(base);
    const op = effectiveCauseKey({ ...base, recovery: { causeGroup: { key: 'c1:other', source: 'operator', decisionId: 'a', confidence: null, assignedAt: NOW, ruleKey: rule } } } as any);
    expect(op.key).toBe('c1:other');
    const model = effectiveCauseKey({ ...base, recovery: { causeGroup: { key: 'c1:other', source: 'model', decisionId: 'd', confidence: 0.9, assignedAt: NOW, ruleKey: rule } } } as any);
    expect(model).toEqual({ key: 'c1:other', source: 'model', decisionId: 'd', confidence: 0.9 });
  });
});
