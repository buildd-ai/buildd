import { describe, expect, it } from 'bun:test';
import {
  VISUAL_IMPACT_CONFIG,
  VISUAL_IMPACT_DECISIONS,
  parseVisualImpactFeatures,
  visualImpactKind,
  visualImpactReasonOf,
  type VisualImpactFeatures,
} from '../decision-kind-visual-impact';
import { listBuilddDecisionKinds } from '../decision-kinds';
import { INFERENCE_CAPABILITIES } from '../inference-policy';

const base: VisualImpactFeatures = {
  protectedHit: false, totalFiles: 4, candidateFiles: 2, candidatesWithoutPatch: 0,
  addedLines: 10, removedLines: 3, markupLines: 2, styleLines: 1, textLines: 0,
};

describe('buildd.visual_impact kind', () => {
  it('is registered against its own opt-in capability', () => {
    expect(listBuilddDecisionKinds().map(k => k.kind)).toContain('buildd.visual_impact');
    expect(visualImpactKind.binding).toMatchObject({ capability: 'visual_impact', mode: 'live' });
    expect(INFERENCE_CAPABILITIES.visual_impact.kind).toBe('opt_in');
    expect([...VISUAL_IMPACT_DECISIONS]).toEqual(['review_required', 'no_visual_impact', 'insufficient_evidence']);
  });
  it('a protected hit is a rule, never asked', () => {
    expect(VISUAL_IMPACT_CONFIG.override?.({ ...base, protectedHit: true })).toEqual({ decision: 'review_required', reasonCode: 'protected_surface' });
    expect(VISUAL_IMPACT_CONFIG.override?.(base)).toBeNull();
  });
  it('every fallback runs the review, including unparseable features', () => {
    for (const cause of ['no_provider', 'low_confidence', 'provider_failure', 'invalid_features'] as const) {
      expect(VISUAL_IMPACT_CONFIG.fallback(base, cause).decision).toBe('review_required');
      expect(VISUAL_IMPACT_CONFIG.fallback(null, cause).decision).toBe('review_required');
    }
  });
  it('refuses malformed features and clamps counters', () => {
    expect(parseVisualImpactFeatures({ ...base, protectedHit: 'no' }).ok).toBe(false);
    expect(parseVisualImpactFeatures({ ...base, markupLines: -1 }).ok).toBe(false);
    expect(parseVisualImpactFeatures(null).ok).toBe(false);
    const p = parseVisualImpactFeatures({ ...base, addedLines: 9e9 });
    if (!p.ok) throw new Error(p.message);
    expect(p.features.addedLines).toBe(100_000);
  });
  it('carries a closed structured reason', () => {
    const out = VISUAL_IMPACT_CONFIG.interpret({ decision: { choice: 'no_visual_impact', confidence: 0.9 }, reason: { choice: 'logic_only', confidence: 0.9 } } as never);
    expect(out).toEqual({ decision: 'no_visual_impact', confidence: 0.9, reasonCode: 'reason_logic_only' });
    expect(visualImpactReasonOf('reason_logic_only')).toBe('logic_only');
    expect(visualImpactReasonOf('fallback_x')).toBeNull();
  });
});
