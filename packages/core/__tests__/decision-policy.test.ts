import { describe, it, expect } from 'bun:test';
import { choice } from '@builddai/ai-kit/decide';
import { defineBuilddDecisionKind, listBuilddDecisionKinds, isMeasuredForKind } from '../decision-kinds';
import { resolveBuilddDecisionRuntime, runBuilddDecision, toDecisionLedgerInput, type BuilddDecisionDeps } from '../decision-policy';
import type { DecisionLedgerInput } from '../decision-ledger';

/**
 * buildd's binding of the decision-kind contract: the team's inference policy
 * and key resolution pick the routes (the caller never names a model), the
 * plan runs in the kit, and every decided call lands one decision-ledger row.
 * Transport, access and the ledger are injected, so nothing here reaches a
 * provider or the DB.
 */

type Probe = 'run' | 'skip';
interface ProbeFeatures { risk: number; mustRun: boolean }

const kind = defineBuilddDecisionKind({
  kind: 'buildd.test_probe_selection',
  policyVersion: '2026-10-03.a',
  featureSchemaVersion: 'v1',
  decisions: ['run', 'skip'] as const,
  parseFeatures: (input: unknown) => {
    const f = input as Partial<ProbeFeatures> | null;
    if (!f || typeof f.risk !== 'number' || f.risk < 0 || f.risk > 1 || typeof f.mustRun !== 'boolean') return { ok: false, message: 'bad' };
    return { ok: true, features: { risk: f.risk, mustRun: f.mustRun } };
  },
  override: f => (f.mustRun ? { decision: 'run', reasonCode: 'must_run' } : null),
  questions: { probe: choice('Run this probe?', { run: 'Likely to find a defect', skip: 'Unlikely to' }) },
  state: f => ({ risk: f.risk }),
  interpret: a => ({ decision: a.probe.choice, confidence: a.probe.confidence, reasonCode: `model_${a.probe.choice}` }),
  minConfidence: 0.8,
  escalation: { minConfidence: 0.7 },
  fallback: (_f, cause) => ({ decision: 'skip', reasonCode: `fallback_${cause}` }),
}, {
  capability: 'surface_audit_advice',
  mode: 'live',
  escalation: { endpoint: 'chat', model: 'acme/rich-1', via: 'openrouter' },
  measuredModels: ['acme/rich-1'],
});

const scope = { teamId: 'team-1', workspaceId: 'ws-1', taskId: 'task-1' };
const feats = (risk = 0.5, mustRun = false): ProbeFeatures => ({ risk, mustRun });

function answer(choiceLabel: Probe, confidence: number, model: string, costUsd = 0.0001) {
  return {
    ok: true as const,
    answers: { probe: { type: 'choice', choice: choiceLabel, confidence, probabilities: { [choiceLabel]: confidence } } },
    model, usage: { inputTokens: 50, outputTokens: 1, costUsd }, latencyMs: 12, attempts: 1,
  };
}

function harness(opts: {
  access?: any;
  rich?: { apiKey: string | null; endpoint?: any; model: string };
  replies?: any[];
} = {}) {
  const calls: any[] = [];
  const rows: DecisionLedgerInput[] = [];
  let i = 0;
  const deps: BuilddDecisionDeps = {
    resolveAccess: (async () => opts.access ?? { ok: true, apiKey: 'k', model: 'typesafe/jev-1.13' }) as any,
    resolveRoute: (async () => opts.rich ?? { apiKey: 'k', endpoint: { kind: 'chat', baseURL: 'https://openrouter.ai/api/v1', provider: 'openrouter' }, model: 'acme/rich-1' }) as any,
    call: (async (p: any) => { calls.push(p); return (opts.replies ?? [answer('run', 0.9, 'typesafe/jev-1.13-20260917')])[Math.min(i++, (opts.replies?.length ?? 1) - 1)]; }) as any,
    record: async row => { rows.push(row); },
  };
  return { deps, calls, rows };
}

describe('defineBuilddDecisionKind', () => {
  it('registers the kind with its binding, and refuses an unknown capability or a non-buildd id', () => {
    expect(listBuilddDecisionKinds().map(k => k.kind)).toContain('buildd.test_probe_selection');
    expect(kind.binding.capability).toBe('surface_audit_advice');
    const base = { ...kind, kind: 'buildd.other' } as any;
    expect(() => defineBuilddDecisionKind(base, { capability: 'nope' as any, mode: 'live' })).toThrow(/capability/);
    expect(() => defineBuilddDecisionKind({ ...base, kind: 'acme.other' }, { capability: 'chat', mode: 'live' })).toThrow(/buildd\./);
  });

  it('measures thresholds on Jev and on the models the kind lists, nothing else', () => {
    expect(isMeasuredForKind(kind.binding, 'typesafe/jev-1.13-20260917')).toBe(true);
    expect(isMeasuredForKind(kind.binding, 'acme/rich-1')).toBe(true);
    expect(isMeasuredForKind(kind.binding, 'acme/rich-1-20261001')).toBe(true);
    expect(isMeasuredForKind(kind.binding, 'acme/rich-10')).toBe(false);
    expect(isMeasuredForKind(kind.binding, 'meta/llama')).toBe(false);
  });
});

describe('resolveBuilddDecisionRuntime', () => {
  it('a disabled capability is a disabled kind, distinct from a missing key', async () => {
    const off = await resolveBuilddDecisionRuntime(kind, scope, harness({ access: { ok: false, error: { kind: 'capability_disabled', capability: 'surface_audit_advice' } } }).deps);
    expect(off).toMatchObject({ mode: 'disabled', cheap: null, unavailable: { kind: 'unavailable', detail: 'capability disabled' } });
    const noKey = await resolveBuilddDecisionRuntime(kind, scope, harness({ access: { ok: false, error: { kind: 'missing_key' } } }).deps);
    expect(noKey).toMatchObject({ mode: 'live', cheap: null, unavailable: { kind: 'unavailable' } });
  });

  it('labels the cheap route from the team\'s resolved access, and the escalation slot from the binding', async () => {
    const rt = await resolveBuilddDecisionRuntime(kind, scope, harness().deps);
    expect(rt.cheap).toMatchObject({ provider: 'openrouter', model: 'typesafe/jev-1.13' });
    expect(rt.escalation).toMatchObject({ provider: 'openrouter', model: 'acme/rich-1' });
  });

  it('no key for the escalation model leaves the slot empty, not the kind', async () => {
    const rt = await resolveBuilddDecisionRuntime(kind, scope, harness({ rich: { apiKey: null, model: 'acme/rich-1' } }).deps);
    expect(rt.cheap).not.toBeNull();
    expect(rt.escalation).toBeNull();
  });

  it('a lookup that throws fails closed to disabled', async () => {
    const h = harness();
    h.deps.resolveAccess = (async () => { throw new Error('db down'); }) as any;
    expect(await resolveBuilddDecisionRuntime(kind, scope, h.deps)).toMatchObject({ mode: 'disabled', cheap: null });
  });
});

describe('runBuilddDecision', () => {
  it('spends through decisionCall with the pre-resolved access, never naming a model in the caller', async () => {
    const h = harness();
    const r = await runBuilddDecision(kind, { features: feats(), subjectRef: { type: 'task', id: 'task-1' } }, scope, h.deps);
    expect(r).toMatchObject({ decision: 'run', source: 'model', provider: 'openrouter', modelVersion: 'typesafe/jev-1.13-20260917' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ capability: 'surface_audit_advice', teamId: 'team-1', decisionId: 'buildd.test_probe_selection' });
    expect(h.calls[0].access).toMatchObject({ ok: true, apiKey: 'k' });
    expect(h.calls[0].apiKey).toBeUndefined();
  });

  it('escalates through the same transport with the escalation key and model', async () => {
    const h = harness({ replies: [answer('skip', 0.5, 'typesafe/jev-1.13-20260917'), answer('run', 0.75, 'acme/rich-1', 0.003)] });
    const r = await runBuilddDecision(kind, { features: feats() }, scope, h.deps);
    expect(r).toMatchObject({ decision: 'run', source: 'model', model: 'acme/rich-1', escalationChain: ['cheap', 'escalation'], escalatedFrom: 0 });
    expect(h.calls[1]).toMatchObject({ apiKey: 'k', model: 'acme/rich-1', endpoint: { kind: 'chat' } });
  });

  it('never applies a confident answer from a team model the kind was not measured on', async () => {
    const h = harness({ access: { ok: true, apiKey: 'k', model: 'meta/llama', endpoint: { kind: 'chat', baseURL: 'https://gw.example.com/v1', provider: 'openai' } }, replies: [answer('run', 0.99, 'meta/llama'), answer('skip', 0.5, 'acme/rich-1')] });
    const r = await runBuilddDecision(kind, { features: feats() }, scope, h.deps);
    expect(r).toMatchObject({ source: 'fallback', decision: 'skip' });
    expect(r.attempts[0]).toMatchObject({ provider: 'openai', outcome: 'unmeasured', applied: false });
  });

  it('writes one ledger row per decided call, with every version stamped and the chain kept', async () => {
    const h = harness({ replies: [answer('skip', 0.5, 'typesafe/jev-1.13-20260917'), answer('run', 0.75, 'acme/rich-1', 0.003)] });
    const r = await runBuilddDecision(kind, { features: feats() }, scope, h.deps);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toEqual(toDecisionLedgerInput(r, scope));
    expect(h.rows[0]).toMatchObject({
      teamId: 'team-1', workspaceId: 'ws-1', taskId: 'task-1', capability: 'buildd.test_probe_selection',
      fingerprint: r.featureDigest, model: 'acme/rich-1', minConfidence: 0.7,
      verdict: 'run', confidence: 0.75, appliedAnswer: 'run', applied: true, status: 'applied',
    });
    expect(h.rows[0].promptVersion).toBe(`2026-10-03.a|v1|${kind.promptFingerprint}|${kind.configFingerprint}`);
    expect(h.rows[0].reason).toContain('chain=cheap>escalation');
    expect(h.rows[0].costUsd).toBeCloseTo(0.0031, 9);
  });

  it('a rule and a fallback are ledger rows too, with the deterministic answer as ruleAnswer', async () => {
    const h = harness({ replies: [answer('run', 0.5, 'typesafe/jev-1.13'), answer('run', 0.5, 'acme/rich-1')] });
    await runBuilddDecision(kind, { features: feats(0.5, true) }, scope, h.deps);
    await runBuilddDecision(kind, { features: feats() }, scope, h.deps);
    expect(h.rows.map(r => [r.status, r.ruleAnswer, r.appliedAnswer, r.applied])).toEqual([
      ['fallback', 'run', 'run', false],
      ['suggested', 'skip', 'skip', false],
    ]);
    expect(h.rows[0].reason).toContain('rule:must_run');
    expect(h.rows[1]).toMatchObject({ verdict: 'run', confidence: 0.5 });
    expect(h.rows[1].reason).toContain('cause=low_confidence');
  });

  it('a disabled kind writes no row and asks nothing, but a rule still decides', async () => {
    const h = harness({ access: { ok: false, error: { kind: 'capability_disabled', capability: 'surface_audit_advice' } } });
    const off = await runBuilddDecision(kind, { features: feats() }, scope, h.deps);
    expect(off).toMatchObject({ source: 'fallback', fallbackCause: 'disabled' });
    const rule = await runBuilddDecision(kind, { features: feats(0.5, true) }, scope, h.deps);
    expect(rule).toMatchObject({ source: 'rule', decision: 'run' });
    expect(h.calls).toHaveLength(0);
    expect(h.rows).toHaveLength(1);
  });

  it('a ledger failure never changes the decision', async () => {
    const h = harness();
    h.deps.record = async () => { throw new Error('insert failed'); };
    const r = await runBuilddDecision(kind, { features: feats() }, scope, h.deps);
    expect(r.decision).toBe('run');
  });

  it('record: false skips the ledger', async () => {
    const h = harness();
    await runBuilddDecision(kind, { features: feats() }, scope, { ...h.deps, record: false });
    expect(h.rows).toHaveLength(0);
  });
});
