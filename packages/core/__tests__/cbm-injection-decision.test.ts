/**
 * CBM search injection's decision (docs/design/cbm-search-injection.md, Flow 4)
 * and the facts contract between runner and server (cbm-injection.ts).
 */
import { describe, expect, it } from 'bun:test';
import { expectDecisionPinned, type DecisionRun } from '@builddai/ai-kit/decide';
import {
  CBM_INJECTION_DECISION,
  CBM_INJECTION_MIN_CONFIDENCE,
  CBM_INJECTION_QUESTIONS,
  buildCbmInjectionState,
  toCbmInjectionReply,
} from '../cbm-injection-decision';
import {
  CBM_INJECTION_OUTCOMES,
  INELIGIBLE_OUTCOMES,
  INJECTED_OUTCOMES,
  NON_EMPTY_DIFF_OUTCOMES,
  emptyCbmInjectionMetrics,
  parseCbmInjectionFacts,
  type CbmInjectionFacts,
} from '../cbm-injection';

const FACTS: CbmInjectionFacts = {
  trigger: 'bash',
  taskKind: 'engineering',
  taskCategory: 'bug',
  missedInManifest: true,
  missedAlreadyEdited: false,
  hitCount: 4,
  hitFiles: 2,
  definitionCount: 1,
  callerCount: 3,
  diffSize: 2,
  definitionMissed: false,
  symbolKind: 'Function',
};

describe('definition', () => {
  it('is pinned: change a definition, the gate or the model, and bump the prompt version', () => {
    expectDecisionPinned(CBM_INJECTION_DECISION, { fingerprint: 'a192b536ad70', version: 'csi1|typesafe/jev-1.13|engine-1' });
  });

  it('is gated, three contrastive labels, no catch-all', () => {
    expect(CBM_INJECTION_DECISION.policyOf('action')).toEqual({ mode: 'gated', minConfidence: CBM_INJECTION_MIN_CONFIDENCE });
    expect(Object.keys(CBM_INJECTION_QUESTIONS.action.criteria).sort()).toEqual(['inject_callers', 'inject_impact', 'skip']);
    for (const def of Object.values(CBM_INJECTION_QUESTIONS.action.criteria)) expect(String(def)).toContain('Not ');
  });
});

describe('state', () => {
  it('is the facts, grouped, with nothing else', () => {
    expect(buildCbmInjectionState(FACTS)).toEqual({
      task: { kind: 'engineering', category: 'bug' },
      search: { tool: 'shell_search', hits: 4, filesWithHits: 2 },
      graph: { symbolKind: 'Function', definitions: 1, directCallers: 3 },
      missed: { locations: 2, shareOfGraph: 0.5, includesDefinition: false, insideDeclaredScope: true, inFileAlreadyEdited: false },
    });
  });
});

describe('parseCbmInjectionFacts', () => {
  it('accepts the documented shape', () => {
    expect(parseCbmInjectionFacts(FACTS)).toEqual({ ok: true, facts: FACTS });
    expect(parseCbmInjectionFacts({ ...FACTS, taskKind: null, symbolKind: null }).ok).toBe(true);
  });

  it('rejects extra fields, so free text cannot ride along', () => {
    expect(parseCbmInjectionFacts({ ...FACTS, symbol: 'parseConfig' })).toEqual({ ok: false, error: "unknown field 'symbol'" });
  });

  it('rejects text where a label belongs, and bad numbers or booleans', () => {
    expect(parseCbmInjectionFacts({ ...FACTS, symbolKind: 'rg -n parseConfig src/' }).ok).toBe(false);
    expect(parseCbmInjectionFacts({ ...FACTS, taskCategory: 'x'.repeat(80) }).ok).toBe(false);
    expect(parseCbmInjectionFacts({ ...FACTS, hitCount: -1 }).ok).toBe(false);
    expect(parseCbmInjectionFacts({ ...FACTS, diffSize: 1.5 }).ok).toBe(false);
    expect(parseCbmInjectionFacts({ ...FACTS, definitionMissed: 'yes' }).ok).toBe(false);
    expect(parseCbmInjectionFacts({ ...FACTS, trigger: 'read' }).ok).toBe(false);
    expect(parseCbmInjectionFacts(null).ok).toBe(false);
  });
});

function run(outcome: unknown, ok = true): DecisionRun<typeof CBM_INJECTION_QUESTIONS> {
  return {
    ok,
    decisionId: CBM_INJECTION_DECISION.id,
    version: CBM_INJECTION_DECISION.version,
    outcomes: { action: outcome } as never,
    result: ok
      ? { ok: true, answers: {} as never, model: 'm', usage: {} as never, latencyMs: 10, attempts: 1 }
      : { ok: false, error: { kind: 'timeout', timeoutMs: 900 } as never, latencyMs: 900, attempts: 1 },
    receipt: null,
  };
}

describe('toCbmInjectionReply', () => {
  it('an applied answer is acted on as given', () => {
    expect(toCbmInjectionReply(run({ status: 'applied', value: 'skip', confidence: 0.92 }), 40)).toEqual({
      ok: true, action: 'skip', status: 'applied', label: 'skip', confidence: 0.92, latencyMs: 40, version: CBM_INJECTION_DECISION.version,
    });
  });

  it('below the gate the action is inject_callers; the model pick is kept as the label', () => {
    expect(toCbmInjectionReply(run({ status: 'suggested', reason: 'below_threshold', value: 'skip', confidence: 0.4 }), 40)).toMatchObject({
      ok: true, action: 'inject_callers', status: 'below_threshold', label: 'skip',
    });
  });

  it('a failed call is an error kind, never a message', () => {
    expect(toCbmInjectionReply(run({ status: 'skipped', reason: 'error', error: { kind: 'timeout' } }, false), 900)).toEqual({
      ok: false, error: 'timeout', latencyMs: 900, version: CBM_INJECTION_DECISION.version,
    });
  });
});

describe('outcome sets', () => {
  it('partition sensibly and only name declared outcomes', () => {
    for (const set of [INJECTED_OUTCOMES, INELIGIBLE_OUTCOMES, NON_EMPTY_DIFF_OUTCOMES]) {
      for (const o of set) expect(CBM_INJECTION_OUTCOMES).toContain(o);
    }
    for (const o of INJECTED_OUTCOMES) expect(NON_EMPTY_DIFF_OUTCOMES.has(o)).toBe(true);
    for (const o of INELIGIBLE_OUTCOMES) expect(NON_EMPTY_DIFF_OUTCOMES.has(o)).toBe(false);
  });

  it('an empty block carries its off reason', () => {
    expect(emptyCbmInjectionMetrics(false, 'kill_switch')).toMatchObject({ enabled: false, disabledReason: 'kill_switch', triggers: 0, events: [] });
    expect('disabledReason' in emptyCbmInjectionMetrics()).toBe(false);
  });
});
