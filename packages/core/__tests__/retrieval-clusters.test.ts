import { describe, it, expect } from 'bun:test';
import {
  TOOL_INFRA_ERROR_V1,
  isToolInfraSignature,
  selectExecCluster,
  isStepWeak,
  type ClusterStep,
} from '../retrieval-clusters';
import { KNOWN_ERROR_SLUGS } from '../subject-anchor-extractor';
import { FRICTION_SIGNATURE_NAMESPACE, toFrictionSignature } from '../failure-friction-signature';

describe('isToolInfraSignature — scope is enforced, not just documented', () => {
  it('accepts every slug in the scanner catalog', () => {
    for (const slug of KNOWN_ERROR_SLUGS) {
      expect(isToolInfraSignature(slug)).toBe(true);
    }
  });

  it('accepts a real worker-failure signature from the friction bridge', () => {
    const sig = toFrictionSignature('Command failed: bwrap: No permissions to creating new namespace');
    expect(sig.startsWith(`${FRICTION_SIGNATURE_NAMESPACE}:`)).toBe(true);
    expect(isToolInfraSignature(sig)).toBe(true);
  });

  it('REJECTS a namespaced signature from an out-of-scope failure family', () => {
    // normalizeErrorSignature accepts any namespace:slug, so it is not
    // sufficient on its own. These are exactly the families the recipe was not
    // designed for and must not silently inherit it.
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
});

describe('selectExecCluster', () => {
  it('selects tool-infra-error-v1 for an in-scope error subject', () => {
    const recipe = selectExecCluster({ subjectKind: 'error', subjectErrorSignature: 'oom_killed' });
    expect(recipe?.name).toBe('tool-infra-error-v1');
  });

  it('returns null for an error subject whose signature is out of scope', () => {
    expect(selectExecCluster({ subjectKind: 'error', subjectErrorSignature: 'compiler:ts2345' })).toBeNull();
  });

  it('returns null for an error subject with no signature', () => {
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

describe('isStepWeak', () => {
  const step = TOOL_INFRA_ERROR_V1.steps[0]!;

  it('is weak when nothing came back', () => {
    expect(isStepWeak([], step)).toBe(true);
  });

  it('is weak when hits are below the score threshold', () => {
    expect(isStepWeak([{ score: 0.1 }, { score: 0.2 }], step)).toBe(true);
  });

  it('is not weak once enough hits clear the threshold', () => {
    expect(isStepWeak([{ score: step.minStrongScore }], step)).toBe(false);
  });

  it('counts only hits at or above the threshold, not the result count', () => {
    const twoRequired: ClusterStep = { ...step, minStrongHits: 2 };
    expect(isStepWeak([{ score: 0.9 }, { score: 0.01 }], twoRequired)).toBe(true);
    expect(isStepWeak([{ score: 0.9 }, { score: 0.9 }], twoRequired)).toBe(false);
  });

  it('reads thresholds off the step, so a per-step change takes effect', () => {
    const lenient: ClusterStep = { ...step, minStrongScore: 0.05 };
    expect(isStepWeak([{ score: 0.1 }], step)).toBe(true);
    expect(isStepWeak([{ score: 0.1 }], lenient)).toBe(false);
  });
});

describe('TOOL_INFRA_ERROR_V1 shape', () => {
  it('orders steps memory -> task -> pr -> code', () => {
    expect(TOOL_INFRA_ERROR_V1.steps.map(s => s.corpus)).toEqual(['memory', 'task', 'pr', 'code']);
    expect(TOOL_INFRA_ERROR_V1.steps.map(s => s.step)).toEqual([1, 2, 3, 4]);
  });

  it('makes code a weakness-gated fallback, not an unconditional hop', () => {
    const code = TOOL_INFRA_ERROR_V1.steps.find(s => s.corpus === 'code')!;
    expect(code.onlyWhenWeak).toBe(true);
    // Priorities, not exclusions: every earlier step runs unconditionally.
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

  it('ships identical thresholds across steps, so the first divergence is deliberate', () => {
    const distinct = new Set(TOOL_INFRA_ERROR_V1.steps.map(s => `${s.minStrongHits}:${s.minStrongScore}`));
    expect(distinct.size).toBe(1);
  });

  it('carries a token budget and an uncertainty note', () => {
    expect(TOOL_INFRA_ERROR_V1.budgetChars).toBeGreaterThan(0);
    expect(TOOL_INFRA_ERROR_V1.uncertaintyNote.length).toBeGreaterThan(0);
  });

  it('does not key a code query on stack symbols, which the scanner cannot produce', () => {
    // The scanner emits only { pattern, excerpt } — no file, line, symbol, or
    // exit code. A stack-symbol step here would be measuring an empty set.
    for (const s of TOOL_INFRA_ERROR_V1.steps) {
      expect(s.derivedBy).not.toBe('regex_stack_extract');
      expect(s.reasonOnHit).not.toBe('stack_symbol_query_hit');
    }
  });
});
