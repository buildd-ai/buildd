import { describe, it, expect } from 'bun:test';
import { choice, defineDecision, JEV_MODEL } from '@builddai/ai-kit/decide';
import {
  ORCHESTRATION_DECISION_DEADLINE_MS,
  assignApplyingArm,
  candidateDigest,
  contentFreeLabel,
  runOrchestrationDecision,
  type OrchestrationDecisionDeps,
  type OrchestrationDecisionRow,
} from '../orchestration-decision';
import { isInferenceAllowed, OPT_IN_CAPABILITIES } from '../inference-policy';

/**
 * The shared access adapter for orchestration decisions (conflict-aware
 * orchestration §5/§6). Every dependency is injected, so these run with no
 * DB, no key and no network.
 */

const QUESTIONS = {
  pick: choice(
    { question: 'Hold or start?', rule: 'Follow the definitions.' },
    { HOLD: 'Wait for the holder.', START: 'Start now.' },
  ),
};

const SHADOW = defineDecision({ id: 'buildd.test_hold_start', promptVersion: 't1', questions: QUESTIONS, mode: 'shadow' });
const GATED = defineDecision({ id: 'buildd.test_hold_start', promptVersion: 't1', questions: QUESTIONS, mode: 'gated', minConfidence: 0.8 });
const LIVE = defineDecision({ id: 'buildd.test_hold_start', promptVersion: 't1', questions: QUESTIONS, mode: 'live' });

const SCOPE = {
  teamId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  taskId: '00000000-0000-4000-8000-000000000003',
  prNumber: 41,
  headSha: 'a'.repeat(40),
  baseRef: 'dev',
};
const POLICY = { version: 'cp1', digest: candidateDigest(['START', 'HOLD']), count: 2 };

function answer(label: string, confidence: number, model = JEV_MODEL) {
  return async () => ({
    ok: true as const,
    answers: { pick: { choice: label, confidence, distribution: { [label]: confidence } } },
    model,
    usage: { inputTokens: 100, outputTokens: 1, costUsd: 0.00002 },
    latencyMs: 12,
    attempts: 1,
  });
}

function harness(over: Partial<OrchestrationDecisionDeps> = {}) {
  const rows: OrchestrationDecisionRow[] = [];
  let calls = 0;
  let retrievals = 0;
  const deps: OrchestrationDecisionDeps = {
    resolveAccess: async () => ({ ok: true, apiKey: 'k', model: JEV_MODEL }),
    call: (async () => { calls++; return answer('START', 0.97)(); }) as any,
    record: async (row) => { rows.push(row); },
    ...over,
  };
  if (over.call) {
    const inner = over.call;
    deps.call = (async (p: any) => { calls++; return inner(p); }) as any;
  }
  const buildState = async () => { retrievals++; return { holderLive: false, overlap: 'advisory' }; };
  return { deps, rows, buildState, counts: () => ({ calls, retrievals }) };
}

const base = (h: ReturnType<typeof harness>, decision: any = SHADOW, extra: Record<string, unknown> = {}) => ({
  decision,
  question: 'pick' as const,
  capability: 'orchestration_claim' as const,
  scope: SCOPE,
  ruleVerdict: 'HOLD',
  candidatePolicy: POLICY,
  buildState: h.buildState,
  deps: h.deps,
  ...extra,
});

describe('capabilities ship dark', () => {
  it('both orchestration capabilities are opt_in and off for a team that has not listed them', () => {
    expect(OPT_IN_CAPABILITIES).toContain('orchestration_manifest');
    expect(OPT_IN_CAPABILITIES).toContain('orchestration_claim');
    expect(isInferenceAllowed('orchestration_claim', { enabledDecisionShadows: null })).toBe(false);
    expect(isInferenceAllowed('orchestration_manifest', { enabledDecisionShadows: ['task_role_shadow'] })).toBe(false);
    expect(isInferenceAllowed('orchestration_claim', { enabledDecisionShadows: ['orchestration_claim'] })).toBe(true);
  });
});

describe('assignApplyingArm', () => {
  it('defaults to a zero applying cohort: everything observes with propensity 1', () => {
    for (let i = 0; i < 50; i++) {
      expect(assignApplyingArm({ unitId: `u${i}`, salt: 's' })).toEqual({ arm: 'observe', propensity: 1, fraction: 0 });
    }
  });

  it('is deterministic per unit and records the propensity of the arm drawn', () => {
    const a = assignApplyingArm({ unitId: 'u1', salt: 's', fraction: 0.5 });
    expect(assignApplyingArm({ unitId: 'u1', salt: 's', fraction: 0.5 })).toEqual(a);
    expect(a.propensity).toBe(0.5);
    const all = assignApplyingArm({ unitId: 'u1', salt: 's', fraction: 1 });
    expect(all).toEqual({ arm: 'apply', propensity: 1, fraction: 1 });
  });

  it('splits roughly at the fraction and clamps nonsense fractions to zero', () => {
    let applied = 0;
    for (let i = 0; i < 2000; i++) if (assignApplyingArm({ unitId: `t-${i}`, salt: 'x', fraction: 0.2 }).arm === 'apply') applied++;
    expect(applied).toBeGreaterThan(300);
    expect(applied).toBeLessThan(500);
    expect(assignApplyingArm({ unitId: 'u', salt: 's', fraction: Number.NaN }).fraction).toBe(0);
    expect(assignApplyingArm({ unitId: 'u', salt: 's', fraction: -1 }).fraction).toBe(0);
    expect(assignApplyingArm({ unitId: 'u', salt: 's', fraction: 7 }).fraction).toBe(1);
  });
});

describe('content-free helpers', () => {
  it('candidateDigest ignores order and duplicates', () => {
    expect(candidateDigest(['b', 'a', 'a'])).toBe(candidateDigest(['a', 'b']));
    expect(candidateDigest(['a'])).not.toBe(candidateDigest(['b']));
    expect(candidateDigest(['a'])).toMatch(/^[0-9a-f]{16}$/);
  });

  it('contentFreeLabel keeps short opaque labels and hashes anything else', () => {
    expect(contentFreeLabel('START')).toBe('START');
    expect(contentFreeLabel('c17')).toBe('c17');
    expect(contentFreeLabel(true)).toBe('true');
    expect(contentFreeLabel(null)).toBeNull();
    const hashed = contentFreeLabel('src/secret/customer path.ts');
    expect(hashed).toMatch(/^h:[0-9a-f]{16}$/);
  });
});

describe('runOrchestrationDecision', () => {
  it('a team that has not opted in: rule verdict, no retrieval, no call, no ledger row', async () => {
    const h = harness({ resolveAccess: async () => ({ ok: false, error: { kind: 'capability_disabled', capability: 'orchestration_claim' } }) as any });
    const out = await runOrchestrationDecision(base(h));
    expect(out).toMatchObject({ effective: 'HOLD', applied: false, status: 'fallback', reason: 'capability_disabled' });
    expect(h.counts()).toEqual({ calls: 0, retrievals: 0 });
    expect(h.rows).toHaveLength(0);
  });

  it('no key: rule verdict, no retrieval or call, one content-free fallback row', async () => {
    const h = harness({ resolveAccess: async () => ({ ok: false, error: { kind: 'missing_key' } }) as any });
    const out = await runOrchestrationDecision(base(h, GATED, { cohort: { fraction: 1 } }));
    expect(out).toMatchObject({ effective: 'HOLD', applied: false, status: 'fallback', reason: 'missing_key' });
    expect(h.counts()).toEqual({ calls: 0, retrievals: 0 });
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ status: 'fallback', reason: 'missing_key', errorKind: 'missing_key', applied: false, suggested: null, ruleVerdict: 'HOLD' });
  });

  it('a throwing access resolver fails closed to the rule', async () => {
    const h = harness({ resolveAccess: async () => { throw new Error('db down'); } });
    const out = await runOrchestrationDecision(base(h));
    expect(out).toMatchObject({ effective: 'HOLD', applied: false, status: 'fallback' });
    expect(h.counts().calls).toBe(0);
  });

  it('shadow is a no-op: the suggestion is recorded, the rule verdict is what the caller acts on', async () => {
    const h = harness();
    const out = await runOrchestrationDecision(base(h, SHADOW, { cohort: { fraction: 1 } }));
    expect(out).toMatchObject({ effective: 'HOLD', applied: false, status: 'suggested', reason: 'shadow', suggested: 'START' });
    expect(h.counts()).toEqual({ calls: 1, retrievals: 1 });
    expect(h.rows).toHaveLength(1);
    const row = h.rows[0];
    expect(row).toMatchObject({
      decisionId: SHADOW.id, decisionVersion: SHADOW.version, fingerprint: SHADOW.fingerprint,
      question: 'pick', mode: 'shadow', capability: 'orchestration_claim',
      candidatePolicyVersion: 'cp1', candidateDigest: POLICY.digest, candidateCount: 2,
      ruleVerdict: 'HOLD', suggested: 'START', applied: false, effective: 'HOLD',
      status: 'suggested', reason: 'shadow', model: JEV_MODEL,
      experimentArm: 'apply', propensity: 1, applyingFraction: 1,
      teamId: SCOPE.teamId, workspaceId: SCOPE.workspaceId, taskId: SCOPE.taskId,
      prNumber: 41, headSha: SCOPE.headSha, baseRef: 'dev',
      costUsd: 0.00002, inputTokens: 100, outputTokens: 1,
    });
    expect(row.confidence).toBeCloseTo(0.97);
    expect(typeof row.latencyMs).toBe('number');
    expect(row.receipt).toMatchObject({ kind: 'decision', outcome: 'ok', model: JEV_MODEL });
  });

  it('gated with the default zero cohort never applies', async () => {
    const h = harness();
    const out = await runOrchestrationDecision(base(h, GATED));
    expect(out).toMatchObject({ effective: 'HOLD', applied: false, reason: 'not_in_cohort', suggested: 'START' });
    expect(h.rows[0]).toMatchObject({ experimentArm: 'observe', propensity: 1, applyingFraction: 0 });
  });

  it('gated + Jev + applying arm + above threshold applies', async () => {
    const h = harness();
    const out = await runOrchestrationDecision(base(h, GATED, { cohort: { fraction: 1 } }));
    expect(out).toMatchObject({ effective: 'START', applied: true, status: 'applied', reason: null });
    expect(h.rows[0]).toMatchObject({ applied: true, effective: 'START', status: 'applied' });
  });

  it('gated below threshold records a suggestion', async () => {
    const h = harness({ call: answer('START', 0.55) as any });
    const out = await runOrchestrationDecision(base(h, GATED, { cohort: { fraction: 1 } }));
    expect(out).toMatchObject({ effective: 'HOLD', applied: false, reason: 'below_threshold', suggested: 'START' });
  });

  it('a non-Jev team model never applies, even in live with a full cohort', async () => {
    const other = 'meta-llama/llama-4-scout';
    const h = harness({
      resolveAccess: async () => ({ ok: true, apiKey: 'k', model: other, endpoint: { kind: 'chat', baseURL: 'https://openrouter.ai/api/v1', provider: 'openrouter' } }) as any,
      call: answer('START', 0.99, other) as any,
    });
    const out = await runOrchestrationDecision(base(h, LIVE, { cohort: { fraction: 1 } }));
    expect(out).toMatchObject({ effective: 'HOLD', applied: false, status: 'suggested', reason: 'non_jev', suggested: 'START' });
    expect(h.rows[0]).toMatchObject({ model: other, applied: false, reason: 'non_jev', mode: 'live' });
  });

  it('routes through the team access: the resolved key, endpoint and model reach the call', async () => {
    let seen: any;
    const h = harness({
      resolveAccess: async () => ({ ok: true, apiKey: 'team-key', model: JEV_MODEL }) as any,
      call: (async (p: any) => { seen = p; return answer('START', 0.9)(); }) as any,
    });
    await runOrchestrationDecision(base(h));
    expect(seen.access).toMatchObject({ ok: true, apiKey: 'team-key' });
    expect(seen.capability).toBe('orchestration_claim');
    expect(seen.teamId).toBe(SCOPE.teamId);
    expect(seen.questions).toBe(SHADOW.questions);
    expect(seen.decisionId).toBe(SHADOW.id);
    expect(seen.timeoutMs).toBeGreaterThan(0);
    expect(seen.timeoutMs).toBeLessThanOrEqual(ORCHESTRATION_DECISION_DEADLINE_MS);
  });

  it('an answer the caller rejects (outside the candidate map) is invalid and falls back', async () => {
    const h = harness();
    const out = await runOrchestrationDecision(base(h, GATED, { cohort: { fraction: 1 }, isValidAnswer: (v: unknown) => v === 'HOLD' }));
    expect(out).toMatchObject({ effective: 'HOLD', applied: false, status: 'fallback', reason: 'invalid' });
    expect(h.rows[0]).toMatchObject({ status: 'fallback', reason: 'invalid', suggested: 'START', applied: false });
  });

  it('a provider parse error is invalid; a provider failure is an error; both fall back', async () => {
    const parse = harness({ call: (async () => ({ ok: false, error: { kind: 'parse', message: 'x' }, latencyMs: 3, attempts: 1 })) as any });
    expect(await runOrchestrationDecision(base(parse))).toMatchObject({ effective: 'HOLD', status: 'fallback', reason: 'invalid' });
    expect(parse.rows[0]).toMatchObject({ errorKind: 'parse', reason: 'invalid' });
    const fivexx = harness({ call: (async () => ({ ok: false, error: { kind: 'provider_error', status: 503, body: 'x' }, latencyMs: 3, attempts: 2 })) as any });
    expect(await runOrchestrationDecision(base(fivexx))).toMatchObject({ effective: 'HOLD', status: 'fallback', reason: 'error' });
    expect(fivexx.rows[0]).toMatchObject({ errorKind: 'provider_error' });
    expect(JSON.stringify(fivexx.rows[0])).not.toContain('"body"');
  });

  it('a decision timeout is a deadline fallback', async () => {
    const h = harness({ call: (async () => ({ ok: false, error: { kind: 'timeout', timeoutMs: 5000 }, latencyMs: 5000, attempts: 1 })) as any });
    expect(await runOrchestrationDecision(base(h))).toMatchObject({ effective: 'HOLD', status: 'fallback', reason: 'deadline' });
  });

  it('retrieval that outlives the overall deadline is abandoned and aborted; no call is made', async () => {
    let aborted = false;
    const h = harness();
    const started = Date.now();
    const out = await runOrchestrationDecision(base(h, GATED, {
      cohort: { fraction: 1 },
      deadlineMs: 40,
      buildState: (signal: AbortSignal) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }),
    }));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out).toMatchObject({ effective: 'HOLD', applied: false, status: 'fallback', reason: 'deadline' });
    expect(aborted).toBe(true);
    expect(h.counts().calls).toBe(0);
    expect(h.rows[0]).toMatchObject({ reason: 'deadline', errorKind: 'deadline' });
  });

  it('a call that ignores its own timeout is still cut off by the overall deadline', async () => {
    const h = harness({ call: (() => new Promise(() => {})) as any });
    const started = Date.now();
    const out = await runOrchestrationDecision(base(h, GATED, { cohort: { fraction: 1 }, deadlineMs: 40 }));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out).toMatchObject({ effective: 'HOLD', status: 'fallback', reason: 'deadline' });
  });

  it('a shared absolute deadline already spent makes no call (a later pick of a repeated choice)', async () => {
    const h = harness();
    const out = await runOrchestrationDecision(base(h, GATED, { cohort: { fraction: 1 }, deadlineAt: Date.now() - 1, step: 3 }));
    expect(out).toMatchObject({ effective: 'HOLD', status: 'fallback', reason: 'deadline' });
    expect(h.counts().calls).toBe(0);
    expect(h.rows[0]).toMatchObject({ step: 3, reason: 'deadline' });
  });

  it('retrieval that throws, or finds nothing to ask, falls back without a call', async () => {
    const thrown = harness();
    expect(await runOrchestrationDecision(base(thrown, SHADOW, { buildState: async () => { throw new Error('vector store down'); } })))
      .toMatchObject({ effective: 'HOLD', status: 'fallback', reason: 'retrieval_error' });
    const empty = harness();
    expect(await runOrchestrationDecision(base(empty, SHADOW, { buildState: async () => null })))
      .toMatchObject({ effective: 'HOLD', status: 'fallback', reason: 'no_candidates' });
    expect(thrown.counts().calls + empty.counts().calls).toBe(0);
  });

  it('a ledger write that throws never changes the outcome', async () => {
    const h = harness({ record: async () => { throw new Error('insert failed'); } });
    const out = await runOrchestrationDecision(base(h, GATED, { cohort: { fraction: 1 } }));
    expect(out).toMatchObject({ effective: 'START', applied: true });
  });

  it('never throws, even when the decision call throws', async () => {
    const h = harness({ call: (async () => { throw new Error('boom'); }) as any });
    const out = await runOrchestrationDecision(base(h));
    expect(out).toMatchObject({ effective: 'HOLD', status: 'fallback', reason: 'error' });
  });

  it('rejects an unknown question name at call time without spending', async () => {
    const h = harness();
    const out = await runOrchestrationDecision({ ...base(h), question: 'nope' as any });
    expect(out).toMatchObject({ effective: 'HOLD', status: 'fallback', reason: 'invalid' });
    expect(h.counts()).toEqual({ calls: 0, retrievals: 0 });
  });

  it('stores opaque labels only: a free-text rule verdict or answer is hashed in the row', async () => {
    const h = harness({ call: answer('START', 0.9) as any });
    await runOrchestrationDecision({ ...base(h), ruleVerdict: 'apps/web/src/secret file.ts' });
    expect(h.rows[0].ruleVerdict).toMatch(/^h:[0-9a-f]{16}$/);
  });
});
