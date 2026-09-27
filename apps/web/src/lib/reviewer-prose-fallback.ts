/**
 * Fallback verdict extraction from prose when structuredOutput is missing.
 *
 * When a reviewer task completes with prose text but no structuredOutput.verdict,
 * this module attempts to extract the verdict from the summary/output.
 */

import type { ReviewerTaskOutput } from './reviewer';

export interface ProseVerdictExtraction {
  verdict: ReviewerTaskOutput['verdict'] | null;
  confidence: number | null;
  reason: string; // Why we extracted it (or why we didn't)
}

// Patterns ordered by priority (highest first).
// Escalate is checked first since it's the highest priority override.
const VERDICT_PATTERNS = [
  // Escalate patterns (highest priority to catch first)
  {
    regex: /\b(?:escalate|escalated|escalation|escalating|needs human review|manual review|human decision|needs decision|blocked|cannot decide)\b/i,
    verdict: 'escalate' as const,
  },
  // Request-changes patterns
  {
    regex: /\b(?:request\s+changes?|request-changes?|requesting\s+changes?|needs\s+changes|change\s+requested|changes\s+requested|do\s+not\s+approve|do\s+not\s+merge|cannot\s+approve|cannot\s+merge)\b/i,
    verdict: 'request-changes' as const,
  },
  // Approve patterns (lowest priority)
  {
    regex: /\b(?:approve|approved|approval|looks good|lgtm|ready to merge)\b/i,
    verdict: 'approve' as const,
  },
];

/**
 * Try to extract a verdict from prose text.
 *
 * Scans the prose for verdict keywords and returns the first match.
 * Escalation keywords are checked first (highest priority), then
 * request-changes, then approve.
 *
 * Default confidence for prose-extracted verdicts is 0.5 (moderate confidence)
 * since we're inferring from text rather than the agent's explicit structured choice.
 */
export function extractVerdictFromProse(prose: string | unknown): ProseVerdictExtraction {
  if (typeof prose !== 'string' || prose.length === 0) {
    return { verdict: null, confidence: null, reason: 'prose is not a non-empty string' };
  }

  // Check patterns in order: escalate first (highest priority), then request-changes, then approve
  for (const pattern of VERDICT_PATTERNS) {
    if (pattern.regex.test(prose)) {
      return {
        verdict: pattern.verdict,
        confidence: 0.5, // Moderate confidence for prose-extracted verdicts
        reason: `extracted '${pattern.verdict}' from prose text`,
      };
    }
  }

  return { verdict: null, confidence: null, reason: 'no verdict keywords found in prose' };
}

/**
 * Construct a structuredOutput with fallback verdict when prose extraction succeeds.
 *
 * Creates a minimal valid ReviewerTaskOutput with:
 * - verdict: extracted from prose
 * - confidence: 0.5 (moderate, since inferred)
 * - summary: extracted from prose (first 500 chars)
 */
export function constructFallbackStructuredOutput(
  prose: string | unknown,
  extraction: ProseVerdictExtraction,
): ReviewerTaskOutput | null {
  if (!extraction.verdict || extraction.confidence === null) return null;

  // Use first ~500 chars of prose as summary if available
  const summary =
    typeof prose === 'string' && prose.length > 0
      ? prose.substring(0, 500).trim()
      : 'Extracted from prose output';

  return {
    verdict: extraction.verdict,
    confidence: extraction.confidence,
    summary,
  };
}
