import { describe, it, expect } from 'bun:test';
import {
  INFERENCE_CAPABILITIES,
  ALL_INFERENCE_CAPABILITIES,
  isInferenceCapability,
  isInferenceEnabled,
  normalizeInferenceCapabilities,
  capabilitiesWithoutFallback,
} from '../inference-policy';

/**
 * Having a key and using it are two decisions. This policy is the second one, per
 * action — so a team can pay for the fast path where latency matters and keep the
 * agent path (free on their subscription seat) everywhere else.
 */

describe('isInferenceEnabled', () => {
  it('is off when nothing is configured', () => {
    // Default off: pasting a credential must not silently start spending on call
    // sites the operator has never seen.
    expect(isInferenceEnabled('criteria_grading', null)).toBe(false);
    expect(isInferenceEnabled('criteria_grading', undefined)).toBe(false);
    expect(isInferenceEnabled('criteria_grading', [])).toBe(false);
  });

  it('is on only for the capabilities named', () => {
    const enabled = ['criteria_grading'];
    expect(isInferenceEnabled('criteria_grading', enabled)).toBe(true);
    expect(isInferenceEnabled('visual_qa', enabled)).toBe(false);
    expect(isInferenceEnabled('task_classification', enabled)).toBe(false);
  });

  it('supports enabling everything', () => {
    for (const c of ALL_INFERENCE_CAPABILITIES) {
      expect(isInferenceEnabled(c, ALL_INFERENCE_CAPABILITIES)).toBe(true);
    }
  });

  it('ignores a name this build does not know', () => {
    // A row written by a newer deploy must not enable spend on a capability this
    // build cannot reason about.
    expect(isInferenceEnabled('criteria_grading', ['something_new'])).toBe(false);
  });
});

describe('normalizeInferenceCapabilities', () => {
  it('keeps known capabilities in a stable order', () => {
    const out = normalizeInferenceCapabilities(['visual_qa', 'criteria_grading']);
    expect(out).toEqual(ALL_INFERENCE_CAPABILITIES.filter(c => c === 'criteria_grading' || c === 'visual_qa'));
  });

  it('drops unknown names rather than storing them', () => {
    expect(normalizeInferenceCapabilities(['criteria_grading', 'nope'])).toEqual(['criteria_grading']);
  });

  it('dedupes', () => {
    expect(normalizeInferenceCapabilities(['criteria_grading', 'criteria_grading'])).toEqual(['criteria_grading']);
  });

  it('collapses every empty form to null so the column has one representation', () => {
    expect(normalizeInferenceCapabilities([])).toBeNull();
    expect(normalizeInferenceCapabilities(['nope'])).toBeNull();
    expect(normalizeInferenceCapabilities(null)).toBeNull();
    expect(normalizeInferenceCapabilities('criteria_grading')).toBeNull();
    expect(normalizeInferenceCapabilities(undefined)).toBeNull();
  });
});

describe('the capability registry', () => {
  it('keys every descriptor by its own id', () => {
    for (const [key, d] of Object.entries(INFERENCE_CAPABILITIES)) {
      expect(d.id).toBe(key);
    }
  });

  it('gives every capability operator-facing copy and a cost hint', () => {
    for (const d of Object.values(INFERENCE_CAPABILITIES)) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(0);
      expect(d.costHint.length).toBeGreaterThan(0);
    }
  });

  it('declares whether an agent run can substitute', () => {
    // The distinction the UI must not flatten: turning off a fallback:'none'
    // capability turns the feature off, it does not make it slower.
    expect(INFERENCE_CAPABILITIES.criteria_grading.fallback).toBe('agent');
    expect(INFERENCE_CAPABILITIES.visual_qa.fallback).toBe('none');
  });

  it('reports which capabilities have no fallback', () => {
    const none = capabilitiesWithoutFallback();
    expect(none).toContain('visual_qa');
    expect(none).not.toContain('criteria_grading');
  });

  it('recognises exactly its own capability names', () => {
    for (const c of ALL_INFERENCE_CAPABILITIES) expect(isInferenceCapability(c)).toBe(true);
    expect(isInferenceCapability('criteria_grading ')).toBe(false);
    expect(isInferenceCapability('')).toBe(false);
    expect(isInferenceCapability(null)).toBe(false);
    expect(isInferenceCapability(42)).toBe(false);
  });
});
