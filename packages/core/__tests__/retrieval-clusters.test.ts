import { describe, it, expect } from 'bun:test';
import {
  TOOL_INFRA_ERROR_V1,
  MIN_STRONG_BY_SIGNAL,
  RECIPE_SCORE_CEILINGS,
  isToolInfraSignature,
  selectExecCluster,
  evaluateStep,
  strengthOf,
  isStrongHit,
  summarizeAssembly,
  type ContextAssembly,
} from '../retrieval-clusters';
import { KNOWN_ERROR_SLUGS } from '../subject-anchor-extractor';
import { FRICTION_SIGNATURE_NAMESPACE, toFrictionSignature } from '../failure-friction-signature';
import { CORPUS_AUTHORITY } from '../knowledge-store/recency-authority';

describe('isToolInfraSignature — scope is enforced, not just documented', () => {
  it('accepts every slug in the scanner catalog', () => {
    for (const slug of KNOWN_ERROR_SLUGS) {
      expect(isToolInfraSignature(slug)).toBe(true);
    }
  });

  it('REJECTS worker-failure signatures, because that namespace is unbounded', () => {
    // toFrictionSignature renders ANY error prose into worker-failure:<stem>_<hash>.
    // Accepting the namespace would have made the scope claim false in the most
    // damaging way: the cohort would mix tool/infra failures with whatever a
    // worker last died on, while the docs asserted it could not.
    const stale = toFrictionSignature('Stale worker expired (no update for <n>+ minutes)');
    const compileish = toFrictionSignature("Type error: Property 'plan' does not exist");
    expect(stale.startsWith(`${FRICTION_SIGNATURE_NAMESPACE}:`)).toBe(true);
    expect(compileish.startsWith(`${FRICTION_SIGNATURE_NAMESPACE}:`)).toBe(true);
    expect(isToolInfraSignature(stale)).toBe(false);
    expect(isToolInfraSignature(compileish)).toBe(false);
  });

  it('rejects every other namespaced family', () => {
    expect(isToolInfraSignature('compiler:ts2345')).toBe(false);
    expect(isToolInfraSignature('vitest:auth-flow-spec')).toBe(false);
    expect(isToolInfraSignature('runtime:TypeError')).toBe(false);
  });

  it('rejects free-form error text, unknown bare slugs, and empties', () => {
    expect(isToolInfraSignature('Error: something went wrong at line 4')).toBe(false);
    expect(isToolInfraSignature('totally_made_up_slug')).toBe(false);
    expect(isToolInfraSignature('')).toBe(false);
    expect(isToolInfraSignature(null)).toBe(false);
    expect(isToolInfraSignature(undefined)).toBe(false);
  });

  it('widens with the catalog rather than restating it', () => {
    // Every accepted bare value is a catalog member — no second hardcoded list
    // that could drift from the scanner.
    for (const slug of ['oom_killed', 'enoent', 'timeout']) {
      expect(KNOWN_ERROR_SLUGS.has(slug)).toBe(isToolInfraSignature(slug));
    }
  });
});

describe('selectExecCluster', () => {
  it('selects tool-infra-error-v1 for an in-scope error subject', () => {
    expect(selectExecCluster({ subjectKind: 'error', subjectErrorSignature: 'oom_killed' })?.name)
      .toBe('tool-infra-error-v1');
  });

  it('returns null for an out-of-scope or missing signature', () => {
    expect(selectExecCluster({ subjectKind: 'error', subjectErrorSignature: 'compiler:ts2345' })).toBeNull();
    expect(selectExecCluster({ subjectKind: 'error', subjectErrorSignature: null })).toBeNull();
  });

  it('returns null for every other subject kind, so the default stays a no-op', () => {
    for (const kind of ['pull_request', 'mission', 'branch']) {
      expect(selectExecCluster({ subjectKind: kind, subjectErrorSignature: 'oom_killed' })).toBeNull();
    }
    expect(selectExecCluster({})).toBeNull();
    expect(selectExecCluster({ subjectKind: null })).toBeNull();
  });
});

describe('strength is judged on a comparable signal, not on score', () => {
  it('prefers rerank, then rrf, then dense, then lexical', () => {
    expect(strengthOf({ scoreBreakdown: { rerank: 0.9, rrf: 0.02, dense: 0.5 } }))
      .toEqual({ value: 0.9, signal: 'rerank' });
    expect(strengthOf({ scoreBreakdown: { rrf: 0.02, dense: 0.5 } }))
      .toEqual({ value: 0.02, signal: 'rrf' });
    expect(strengthOf({ scoreBreakdown: { dense: 0.5 } }))
      .toEqual({ value: 0.5, signal: 'dense' });
    expect(strengthOf({ scoreBreakdown: { lexical: 0.1 } }))
      .toEqual({ value: 0.1, signal: 'lexical' });
  });

  it('reports no signal rather than falling back to score', () => {
    // Falling back to `score` is the bug this type exists to prevent: `score`
    // is post-decay and post-authority, so thresholding it against a pre-decay
    // constant encodes corpus authority and chunk age as "strength".
    expect(strengthOf({}).signal).toBe('none');
    expect(strengthOf({ scoreBreakdown: {} }).signal).toBe('none');
    expect(strengthOf({}).value).toBeNull();
  });

  it('thresholds per signal, since the signal sets the scale', () => {
    // An RRF value of 0.02 is strong; a rerank value of 0.02 is not. One
    // constant across both would be meaningless.
    expect(isStrongHit({ scoreBreakdown: { rrf: 0.02 } })).toBe(true);
    expect(isStrongHit({ scoreBreakdown: { rerank: 0.02 } })).toBe(false);
    expect(MIN_STRONG_BY_SIGNAL.rrf).toBeLessThan(MIN_STRONG_BY_SIGNAL.rerank);
  });

  it('is never satisfiable-by-arithmetic-alone for any recipe step', () => {
    // The regression that motivated all of this: a single 0.5 threshold on
    // `score` made the `task` step (authority 0.4) provably always weak, so the
    // escalation flag was a constant. Assert no threshold now exceeds the
    // ceiling of the signal it is applied to.
    for (const { corpus, scoreCeiling } of RECIPE_SCORE_CEILINGS) {
      expect(scoreCeiling).toBe(CORPUS_AUTHORITY[corpus]);
      // rerank is corpus-independent, so the ceiling that broke the old
      // predicate must not bound the new threshold.
      expect(MIN_STRONG_BY_SIGNAL.rerank).toBeGreaterThan(0);
      expect(MIN_STRONG_BY_SIGNAL.rerank).toBeLessThanOrEqual(1);
    }
    // And the specific arithmetic: a perfect task hit is reachable now.
    expect(isStrongHit({ scoreBreakdown: { rerank: 0.6 } })).toBe(true);
  });
});

describe('evaluateStep', () => {
  const step = { minStrongHits: 1 };

  it('treats an empty step as weak, not neutral', () => {
    expect(evaluateStep([], step)).toEqual({ weak: true, strongHits: 0, signal: 'none', countOnly: false });
  });

  it('is weak when no hit clears its signal threshold', () => {
    const r = evaluateStep([{ scoreBreakdown: { rerank: 0.1 } }, { scoreBreakdown: { rerank: 0.2 } }], step);
    expect(r.weak).toBe(true);
    expect(r.strongHits).toBe(0);
    expect(r.signal).toBe('rerank');
  });

  it('is not weak once enough hits clear it', () => {
    const r = evaluateStep([{ scoreBreakdown: { rerank: 0.8 } }], step);
    expect(r.weak).toBe(false);
    expect(r.strongHits).toBe(1);
  });

  it('counts strong hits, not results', () => {
    const two = { minStrongHits: 2 };
    expect(evaluateStep([{ scoreBreakdown: { rerank: 0.9 } }, { scoreBreakdown: { rerank: 0.01 } }], two).weak)
      .toBe(true);
    expect(evaluateStep([{ scoreBreakdown: { rerank: 0.9 } }, { scoreBreakdown: { rerank: 0.9 } }], two).weak)
      .toBe(false);
  });

  it('falls back to counting when strength is unjudgeable, and says so', () => {
    const r = evaluateStep([{}], step);
    expect(r.countOnly).toBe(true);
    expect(r.signal).toBe('none');
    expect(r.weak).toBe(false);
    // A count-only verdict and a rerank-backed one are not the same evidence,
    // so the distinction has to survive into the record.
    expect(evaluateStep([{ scoreBreakdown: { rerank: 0.9 } }], step).countOnly).toBe(false);
  });
});

describe('TOOL_INFRA_ERROR_V1 shape', () => {
  it('orders steps memory -> task -> pr -> code', () => {
    expect(TOOL_INFRA_ERROR_V1.steps.map(s => s.corpus)).toEqual(['memory', 'task', 'pr', 'code']);
    expect(TOOL_INFRA_ERROR_V1.steps.map(s => s.step)).toEqual([1, 2, 3, 4]);
  });

  it('makes code a weakness-gated escalation, not an unconditional hop', () => {
    const code = TOOL_INFRA_ERROR_V1.steps.find(s => s.corpus === 'code')!;
    expect(code.onlyWhenWeak).toBe(true);
    for (const s of TOOL_INFRA_ERROR_V1.steps.filter(s => s.step < code.step)) {
      expect(s.onlyWhenWeak).toBeUndefined();
    }
  });

  it('queries code lexically, since its key is a list of literal paths', () => {
    expect(TOOL_INFRA_ERROR_V1.steps.find(s => s.corpus === 'code')!.mode).toBe('lexical');
  });

  it('scopes memory to the team and everything else to the workspace', () => {
    for (const s of TOOL_INFRA_ERROR_V1.steps) {
      expect(s.scope).toBe(s.corpus === 'memory' ? 'team' : 'workspace');
    }
  });

  it('emits no reason naming a relevance judgment', () => {
    for (const s of TOOL_INFRA_ERROR_V1.steps) {
      expect(s.reasonOnHit.endsWith('_match')).toBe(false);
      expect(s.reasonOnHit.endsWith('_query_hit')).toBe(true);
    }
  });

  it('does not key a code query on stack symbols, which the scanner cannot produce', () => {
    for (const s of TOOL_INFRA_ERROR_V1.steps) {
      expect(s.derivedBy).not.toBe('regex_stack_extract');
      expect(s.reasonOnHit).not.toBe('stack_symbol_query_hit');
    }
  });

  it('carries a token budget and an uncertainty note', () => {
    expect(TOOL_INFRA_ERROR_V1.budgetChars).toBeGreaterThan(0);
    expect(TOOL_INFRA_ERROR_V1.uncertaintyNote.length).toBeGreaterThan(0);
  });
});

describe('summarizeAssembly — the bounded half of the record', () => {
  const assembly: ContextAssembly = {
    assemblyId: 'a-1',
    at: '2026-09-05T00:00:00.000Z',
    recipe: 'tool-infra-error-v1',
    source: 'live',
    workspaceId: 'ws-1',
    teamId: 'team-1',
    trigger: { layer: 'exec', subjectKind: 'error', signature: 'oom_killed' },
    derivedKeys: { paths: ['apps/runner/src/workers.ts'] },
    items: [
      { step: 1, reason: 'error_signature_query_hit', chunkId: 'c1' },
      { step: 2, reason: 'step_query_empty' },
    ],
    weakEscalationFired: true,
    fallbackFired: false,
    chain: { taskId: 't-1', workerId: 'w-1', missionId: null },
  };

  it('drops items and keys but keeps every field the day-one metrics need', () => {
    const s = summarizeAssembly(assembly);
    expect('items' in s).toBe(false);
    expect('derivedKeys' in s).toBe(false);
    expect(s.itemCount).toBe(2);
    expect(s.pathCount).toBe(1);
    for (const field of ['assemblyId', 'at', 'recipe', 'source', 'workspaceId', 'teamId', 'fallbackFired', 'weakEscalationFired'] as const) {
      expect(s[field]).toBeDefined();
    }
  });

  it('stays small enough that it cannot be the line that gets truncated', () => {
    // The reason the record is two lines rather than one reordered line: a line
    // truncated mid-array is invalid JSON and JSON.parse rejects all of it, so
    // field order buys nothing. Size is the only property that helps.
    const worst = summarizeAssembly({
      ...assembly,
      derivedKeys: { paths: Array.from({ length: 20 }, (_, i) => `packages/core/${'x'.repeat(180)}-${i}.ts`) },
      items: Array.from({ length: 12 }, () => ({ step: 4, reason: 'touched_file_query_hit' as const })),
    });
    expect(JSON.stringify(worst).length).toBeLessThan(4096);
  });
});
