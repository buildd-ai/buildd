import { describe, it, expect } from 'bun:test';
import {
  extractVerdictFromProse,
  constructFallbackStructuredOutput,
} from './reviewer-prose-fallback';

describe('extractVerdictFromProse', () => {
  it('extracts approve verdict', () => {
    const prose = 'This looks great, I approve the changes. Ready to merge.';
    const result = extractVerdictFromProse(prose);
    expect(result.verdict).toBe('approve');
    // Confidence based on position in text (towards the end)
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('extracts approved variant', () => {
    const prose = 'The code is clean and well-tested. Approved!';
    const result = extractVerdictFromProse(prose);
    expect(result.verdict).toBe('approve');
  });

  it('extracts LGTM', () => {
    const prose = 'LGTM, let\'s ship this.';
    const result = extractVerdictFromProse(prose);
    expect(result.verdict).toBe('approve');
  });

  it('extracts request-changes verdict', () => {
    const prose = 'I request-changes on this PR. Please address the comments.';
    const result = extractVerdictFromProse(prose);
    expect(result.verdict).toBe('request-changes');
    // Confidence is mid-range since it's in the middle of the text
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it('extracts request changes variant', () => {
    const prose = 'Please request changes - there are several issues to address.';
    const result = extractVerdictFromProse(prose);
    expect(result.verdict).toBe('request-changes');
  });

  it('extracts cannot approve variant', () => {
    const prose = 'I cannot approve this in its current state.';
    const result = extractVerdictFromProse(prose);
    expect(result.verdict).toBe('request-changes');
  });

  it('extracts escalate verdict', () => {
    const prose = 'This needs escalation. The decision is beyond my scope.';
    const result = extractVerdictFromProse(prose);
    expect(result.verdict).toBe('escalate');
    // Prose-extracted verdicts use conservative confidence
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result.confidence).toBeLessThan(0.6);
  });

  it('extracts needs human review variant', () => {
    const prose = 'This needs human review before merging.';
    const result = extractVerdictFromProse(prose);
    expect(result.verdict).toBe('escalate');
  });

  it('prioritizes escalate over request-changes', () => {
    const prose = 'I request-changes and also escalate this for human review.';
    const result = extractVerdictFromProse(prose);
    // Should find escalate first since it's higher priority
    expect(result.verdict).toBe('escalate');
  });

  it('prioritizes escalate over approve', () => {
    const prose = 'This looks good but needs escalation for policy reasons.';
    const result = extractVerdictFromProse(prose);
    expect(result.verdict).toBe('escalate');
  });

  // Regression tests for hedge/negation cases from the prior failure
  it('handles hedge: considered changes but will approve', () => {
    const prose = 'I considered whether to request changes here, but the issues are minor, so I will approve this PR.';
    const result = extractVerdictFromProse(prose);
    // Should extract the final verdict (approve), not the hedged one (request-changes)
    expect(result.verdict).toBe('approve');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('handles negation: no changes requested, this is approve', () => {
    const prose = 'No changes requested here — this is a clean approve.';
    const result = extractVerdictFromProse(prose);
    // Should extract approve, not request-changes (which is negated)
    expect(result.verdict).toBe('approve');
  });

  it('handles negation: does not need manual review, approve', () => {
    const prose = 'This PR does not need any manual review beyond what is already documented. Approve.';
    const result = extractVerdictFromProse(prose);
    // Should extract approve, not escalate (which is negated by "does not need manual review")
    expect(result.verdict).toBe('approve');
  });

  it('handles negation: not blocked, looks good', () => {
    const prose = 'This is not blocked by anything and looks good.';
    const result = extractVerdictFromProse(prose);
    // Should extract approve (looks good), not escalate (blocked is negated)
    expect(result.verdict).toBe('approve');
  });

  it('prefers last verdict keyword when multiple present', () => {
    const prose = 'I initially thought we might need escalation, but after review, this looks good. Approve.';
    const result = extractVerdictFromProse(prose);
    expect(result.verdict).toBe('approve');
  });

  it('handles empty string', () => {
    const result = extractVerdictFromProse('');
    expect(result.verdict).toBeNull();
    expect(result.confidence).toBeNull();
  });

  it('handles non-string input', () => {
    const result = extractVerdictFromProse(123 as unknown);
    expect(result.verdict).toBeNull();
  });

  it('returns null for no matching verdict', () => {
    const prose = 'This is just some random text without any verdict keywords.';
    const result = extractVerdictFromProse(prose);
    expect(result.verdict).toBeNull();
    expect(result.confidence).toBeNull();
  });

  it('is case-insensitive', () => {
    const result1 = extractVerdictFromProse('APPROVE THIS CHANGE');
    expect(result1.verdict).toBe('approve');

    const result2 = extractVerdictFromProse('REQUEST-CHANGES needed');
    expect(result2.verdict).toBe('request-changes');

    const result3 = extractVerdictFromProse('ESCALATE to human');
    expect(result3.verdict).toBe('escalate');
  });

  it('assigns slightly higher confidence to verdicts near the end', () => {
    const prose = 'This looks good. Approve.';
    const result = extractVerdictFromProse(prose);
    // Even near the end, prose verdicts stay below the 0.6 default threshold
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.confidence).toBeLessThan(0.6);
  });

  it('assigns lower confidence to matches in early text', () => {
    const prose = 'Approve the early structure, but now I see issues. Request-changes needed.';
    const result = extractVerdictFromProse(prose);
    // Should prefer request-changes (later) over approve (earlier)
    expect(result.verdict).toBe('request-changes');
  });
});

describe('extractVerdictFromProse — declared verdict and confidence', () => {
  it('honors a leading "verdict (confidence)" declaration over keyword scanning', () => {
    const prose =
      'request-changes (0.97): raw task title is appended after redaction and reaches embedder. ' +
      'Fix: redact after the title is appended; regression test: title with a secret never reaches the embedder. ' +
      'Nothing here needs escalation to a human.';
    const result = extractVerdictFromProse(prose);
    expect(result.verdict).toBe('request-changes');
    expect(result.confidence).toBe(0.97);
  });

  it('accepts a "Verdict:" prefix and a spaced verdict word', () => {
    const result = extractVerdictFromProse('Verdict: request changes (0.9) - see feedback. Please escalate nothing.');
    expect(result.verdict).toBe('request-changes');
    expect(result.confidence).toBe(0.9);
  });

  it('keeps a declared low confidence low', () => {
    const result = extractVerdictFromProse('escalate (0.4): unsure who owns this');
    expect(result.verdict).toBe('escalate');
    expect(result.confidence).toBe(0.4);
  });

  it('never lets a prose-declared approve clear the confidence gate', () => {
    const result = extractVerdictFromProse('approve (0.99): looks fine');
    expect(result.verdict).toBe('approve');
    expect(result.confidence).toBeLessThan(0.6);
  });

  it('ignores an out-of-range declared confidence and falls back to keyword scanning', () => {
    const result = extractVerdictFromProse('request-changes (97): bad');
    expect(result.verdict).toBe('request-changes');
    expect(result.confidence).toBeLessThan(0.6);
  });

  it('only reads the declaration from the start of the prose', () => {
    const result = extractVerdictFromProse('I thought about it. request-changes (0.97) is what a careless model would say; I approve.');
    expect(result.confidence).toBeLessThan(0.6);
  });
});

describe('constructFallbackStructuredOutput', () => {
  it('constructs output from successful extraction', () => {
    const prose = 'This code looks good and is approved for merge.';
    const extraction = extractVerdictFromProse(prose);
    const output = constructFallbackStructuredOutput(prose, extraction);

    expect(output).toBeTruthy();
    expect(output!.verdict).toBe('approve');
    // Confidence is based on position in text
    expect(output!.confidence).toBeGreaterThan(0.5);
    expect(output!.summary).toContain('code looks good');
  });

  it('returns null when extraction has no verdict', () => {
    const extraction = {
      verdict: null as const,
      confidence: null,
      reason: 'no verdict found',
    };
    const output = constructFallbackStructuredOutput('some text', extraction);
    expect(output).toBeNull();
  });

  it('truncates long prose summaries', () => {
    const longProse =
      'A'.repeat(1000); // 1000 characters
    const extraction = extractVerdictFromProse(longProse);
    if (extraction.verdict) {
      const output = constructFallbackStructuredOutput(longProse, extraction);
      expect(output!.summary.length).toBeLessThanOrEqual(500);
    }
  });

  it('handles non-string prose', () => {
    const extraction = {
      verdict: 'approve' as const,
      confidence: 0.5,
      reason: 'test',
    };
    const output = constructFallbackStructuredOutput(123, extraction);
    expect(output!.summary).toBe('Extracted from prose output');
  });
});
