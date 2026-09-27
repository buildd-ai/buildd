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
    expect(result.confidence).toBe(0.5);
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
    expect(result.confidence).toBe(0.5);
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
    expect(result.confidence).toBe(0.5);
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
});

describe('constructFallbackStructuredOutput', () => {
  it('constructs output from successful extraction', () => {
    const prose = 'This code looks good and is approved for merge.';
    const extraction = extractVerdictFromProse(prose);
    const output = constructFallbackStructuredOutput(prose, extraction);

    expect(output).toBeTruthy();
    expect(output!.verdict).toBe('approve');
    expect(output!.confidence).toBe(0.5);
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
