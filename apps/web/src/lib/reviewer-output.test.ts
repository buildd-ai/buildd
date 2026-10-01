import { describe, it, expect } from 'bun:test';
import { parseReviewerOutput, applyConfidenceGate, DEFAULT_REVIEW_CONFIDENCE_THRESHOLD } from './reviewer-output';

describe('parseReviewerOutput', () => {
  const valid = { verdict: 'approve', confidence: 0.9, summary: 'Looks right' };

  it('accepts a well-formed verdict and keeps the optional fields', () => {
    const res = parseReviewerOutput({ ...valid, feedback: 'n/a', correctedLede: 'x' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.output.verdict).toBe('approve');
      expect(res.output.confidence).toBe(0.9);
      expect(res.output.correctedLede).toBe('x');
    }
  });

  it('accepts each verdict in the enum', () => {
    for (const verdict of ['approve', 'request-changes', 'escalate']) {
      expect(parseReviewerOutput({ ...valid, verdict }).ok).toBe(true);
    }
  });

  it('accepts the confidence bounds 0 and 1', () => {
    expect(parseReviewerOutput({ ...valid, confidence: 0 }).ok).toBe(true);
    expect(parseReviewerOutput({ ...valid, confidence: 1 }).ok).toBe(true);
  });

  // Regression: the contract guard only checked that `verdict` was truthy, so
  // an out-of-enum verdict fell through the outcome switch doing nothing and
  // the PR read as review_failed, which lets the merge gate pass.
  it('rejects an out-of-enum verdict', () => {
    const res = parseReviewerOutput({ ...valid, verdict: 'approved' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('verdict');
  });

  it('normalizes case and separator variants to the canonical verdict', () => {
    for (const variant of ['request_changes', 'requestChanges', 'REQUEST-CHANGES', 'Request Changes', ' request-changes ']) {
      const res = parseReviewerOutput({ ...valid, verdict: variant });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.output.verdict).toBe('request-changes');
    }
    const upper = parseReviewerOutput({ ...valid, verdict: 'APPROVE' });
    expect(upper.ok && upper.output.verdict).toBe('approve');
  });

  it('does not mutate the caller payload when normalizing', () => {
    const raw = { ...valid, verdict: 'request_changes' };
    parseReviewerOutput(raw);
    expect(raw.verdict).toBe('request_changes');
  });

  it('still rejects a different word, and names the allowed values', () => {
    const res = parseReviewerOutput({ ...valid, verdict: 'reject' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('"request-changes"');
  });

  it('rejects a missing verdict or a non-object payload', () => {
    expect(parseReviewerOutput({ confidence: 0.9, summary: 's' }).ok).toBe(false);
    expect(parseReviewerOutput(null).ok).toBe(false);
    expect(parseReviewerOutput(undefined).ok).toBe(false);
    expect(parseReviewerOutput('approve').ok).toBe(false);
    expect(parseReviewerOutput([valid]).ok).toBe(false);
  });

  // Regression: a string confidence threw at `.toFixed` in the outcome handler.
  it('rejects a string confidence rather than coercing it', () => {
    const res = parseReviewerOutput({ ...valid, confidence: '0.9' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('confidence');
  });

  it('rejects a confidence outside [0, 1] rather than rescaling it', () => {
    expect(parseReviewerOutput({ ...valid, confidence: 85 }).ok).toBe(false);
    expect(parseReviewerOutput({ ...valid, confidence: -0.1 }).ok).toBe(false);
    expect(parseReviewerOutput({ ...valid, confidence: Number.NaN }).ok).toBe(false);
    expect(parseReviewerOutput({ ...valid, confidence: Number.POSITIVE_INFINITY }).ok).toBe(false);
  });

  it('rejects a missing or non-string summary', () => {
    expect(parseReviewerOutput({ verdict: 'approve', confidence: 0.9 }).ok).toBe(false);
    expect(parseReviewerOutput({ ...valid, summary: 42 }).ok).toBe(false);
  });
});

describe('applyConfidenceGate', () => {
  it('escalates an approve below the threshold and says why', () => {
    const res = applyConfidenceGate({ verdict: 'approve', confidence: 0.3, threshold: 0.6 });
    expect(res.verdict).toBe('escalate');
    expect(res.overrideReason).toBe('confidence 0.30 below workspace threshold 0.60');
  });

  it('keeps an approve at or above the threshold', () => {
    expect(applyConfidenceGate({ verdict: 'approve', confidence: 0.6, threshold: 0.6 })).toEqual({ verdict: 'approve', overrideReason: null });
    expect(applyConfidenceGate({ verdict: 'approve', confidence: 0.9, threshold: 0.6 })).toEqual({ verdict: 'approve', overrideReason: null });
  });

  it('uses the platform default threshold when the workspace sets none', () => {
    expect(DEFAULT_REVIEW_CONFIDENCE_THRESHOLD).toBe(0.6);
    expect(applyConfidenceGate({ verdict: 'approve', confidence: 0.5 }).verdict).toBe('escalate');
    expect(applyConfidenceGate({ verdict: 'approve', confidence: 0.7 }).verdict).toBe('approve');
  });

  it('honours a stricter workspace threshold', () => {
    expect(applyConfidenceGate({ verdict: 'approve', confidence: 0.7, threshold: 0.8 }).verdict).toBe('escalate');
  });

  it('escalates low-confidence request-changes to prevent misclassified prose verdicts from acting immediately', () => {
    // Low confidence request-changes (e.g., from prose fallback) should escalate for human review
    const res = applyConfidenceGate({ verdict: 'request-changes', confidence: 0.5, threshold: 0.6 });
    expect(res.verdict).toBe('escalate');
    expect(res.overrideReason).toContain('request-changes');
    expect(res.overrideReason).toContain('below workspace threshold');
  });

  it('keeps high-confidence request-changes even above threshold', () => {
    // High confidence request-changes passes through
    expect(applyConfidenceGate({ verdict: 'request-changes', confidence: 0.8, threshold: 0.6 })).toEqual({
      verdict: 'request-changes',
      overrideReason: null,
    });
  });

  it('escalates low-confidence escalate to prevent misclassified prose verdicts from acting immediately', () => {
    // Low confidence escalate (e.g., from prose fallback) should escalate for human review
    const res = applyConfidenceGate({ verdict: 'escalate', confidence: 0.5, threshold: 0.6 });
    expect(res.verdict).toBe('escalate');
    expect(res.overrideReason).toContain('escalate');
    expect(res.overrideReason).toContain('below workspace threshold');
  });

  it('keeps high-confidence escalate', () => {
    expect(applyConfidenceGate({ verdict: 'escalate', confidence: 0.8, threshold: 0.6 })).toEqual({
      verdict: 'escalate',
      overrideReason: null,
    });
  });

  it('applies confidence gate uniformly across all verdict types', () => {
    const threshold = 0.6;
    // All three verdict types should pass through at/above threshold
    expect(applyConfidenceGate({ verdict: 'approve', confidence: 0.6, threshold }).verdict).toBe('approve');
    expect(applyConfidenceGate({ verdict: 'request-changes', confidence: 0.6, threshold }).verdict).toBe('request-changes');
    expect(applyConfidenceGate({ verdict: 'escalate', confidence: 0.6, threshold }).verdict).toBe('escalate');

    // All three should escalate below threshold
    expect(applyConfidenceGate({ verdict: 'approve', confidence: 0.5, threshold }).verdict).toBe('escalate');
    expect(applyConfidenceGate({ verdict: 'request-changes', confidence: 0.5, threshold }).verdict).toBe('escalate');
    expect(applyConfidenceGate({ verdict: 'escalate', confidence: 0.5, threshold }).verdict).toBe('escalate');
  });
});
