/**
 * Fallback verdict extraction from prose when structuredOutput is missing.
 *
 * When a reviewer task completes with prose text but no structuredOutput.verdict,
 * this module attempts to extract the verdict from the summary/output.
 *
 * Strategy: Extract verdict from the LAST occurrence of verdict keywords in the text,
 * preferring matches in the final sentences. Avoid matches that are negated
 * (e.g., "I considered requesting changes, but I'll approve").
 */

import type { ReviewerTaskOutput } from './reviewer';

export interface ProseVerdictExtraction {
  verdict: ReviewerTaskOutput['verdict'] | null;
  confidence: number | null;
  reason: string;
}

// Verdict patterns with their associated keywords.
// These are used to find all occurrences, not just the first.
const VERDICT_PATTERNS = {
  escalate: [
    'escalate', 'escalated', 'escalation', 'escalating',
    'needs human review', 'manual review', 'human decision', 'needs decision',
    'blocked',
  ],
  'request-changes': [
    'request changes', 'request-changes', 'requesting changes',
    'needs changes', 'change requested', 'changes requested',
    'do not approve', 'do not merge', 'cannot approve', 'cannot merge', 'cannot decide',
  ],
  approve: [
    'approve', 'approved', 'approval',
    'looks good', 'lgtm', 'ready to merge',
  ],
};

/**
 * Check if a match at given position is preceded by negation.
 * Returns true if the match should be excluded due to negation.
 *
 * Negation patterns:
 * - "no changes requested" → filter out the "changes requested" match
 * - "does not need manual review" → filter out "manual review"
 * - "not blocked by" → filter out "blocked"
 *
 * Only checks the ~20 characters immediately before the match to avoid false
 * positives from unrelated negations earlier in the sentence.
 *
 * But NOT for "cannot approve" or "cannot merge" — those are themselves verdicts
 * (request-changes keywords), not negations of approve/escalate.
 */
function isNegatedMatch(prose: string, matchPos: number, keyword: string): boolean {
  // "cannot approve" and "cannot merge" are verdict keywords themselves, not negations
  if (keyword.includes('cannot') || keyword.includes('cannot approve') || keyword.includes('cannot merge')) {
    return false; // These are already part of the verdict keywords
  }

  // Only look at the ~20 characters immediately before the match for negation
  const searchStart = Math.max(0, matchPos - 20);
  const beforeMatch = prose.substring(searchStart, matchPos).toLowerCase();

  // Check for negation patterns immediately before the keyword
  // Must match right before the keyword (no intervening words)
  if (/\b(?:no|not|doesn't|do\s+not|don't|never)\s*$/.test(beforeMatch.trim())) {
    // Exception: "considered X but Y" should not negate Y if Y is after "but"
    if (/but\s*$/.test(beforeMatch.trim())) {
      return false; // The "but" clause overrides preceding negation
    }
    return true;
  }

  return false;
}

/**
 * Find all matches of a verdict keyword in prose, returning their positions.
 * Filters out overlapping matches, preferring longer keywords.
 */
function findVerdictMatches(
  prose: string,
  keywords: string[],
): Array<{ keyword: string; pos: number; length: number }> {
  const matches: Array<{ keyword: string; pos: number; length: number }> = [];
  const proseLower = prose.toLowerCase();

  for (const keyword of keywords) {
    const keywordLower = keyword.toLowerCase();
    let pos = 0;
    while ((pos = proseLower.indexOf(keywordLower, pos)) !== -1) {
      matches.push({ keyword, pos, length: keywordLower.length });
      pos += keywordLower.length;
    }
  }

  // Sort by position, then by length descending (prefer longer matches at same position)
  matches.sort((a, b) => {
    if (a.pos !== b.pos) return a.pos - b.pos;
    return b.length - a.length;
  });

  // Filter overlapping matches - keep the longest one at each position
  const filtered: Array<{ keyword: string; pos: number; length: number }> = [];
  let lastEndPos = -1;

  for (const match of matches) {
    // If this match doesn't overlap with the last kept match, keep it
    if (match.pos >= lastEndPos) {
      filtered.push(match);
      lastEndPos = match.pos + match.length;
    }
  }

  return filtered;
}

/**
 * Extract verdict from prose text.
 *
 * Strategy:
 * 1. Find all matches of all verdict keywords
 * 2. Prefer matches later in the prose (closer to conclusion)
 * 3. Skip matches that are negated or inside hedging clauses
 * 4. Return the last unambiguous match
 *
 * Confidence scoring:
 * - 0.8: Last sentence clearly states verdict
 * - 0.6: Verdict found in final 2 sentences with no contradictions
 * - 0.4: Verdict found but with conflicting signals
 * - 0.3: Weak signal (only in early hedging context)
 */
export function extractVerdictFromProse(prose: string | unknown): ProseVerdictExtraction {
  if (typeof prose !== 'string' || prose.length === 0) {
    return { verdict: null, confidence: null, reason: 'prose is not a non-empty string' };
  }

  // Find all matches for each verdict type
  const escalateMatches = findVerdictMatches(prose, VERDICT_PATTERNS.escalate).map(m => ({
    ...m,
    verdictType: 'escalate' as const,
  }));
  const requestChangesMatches = findVerdictMatches(prose, VERDICT_PATTERNS['request-changes']).map(m => ({
    ...m,
    verdictType: 'request-changes' as const,
  }));
  const approveMatches = findVerdictMatches(prose, VERDICT_PATTERNS.approve).map(m => ({
    ...m,
    verdictType: 'approve' as const,
  }));

  // Combine all matches and sort by position
  const allMatches = [...escalateMatches, ...requestChangesMatches, ...approveMatches].sort(
    (a, b) => a.pos - b.pos,
  );

  // Filter overlapping matches globally - prefer longer matches
  const filtered: typeof allMatches = [];
  let lastEndPos = -1;

  for (const match of allMatches) {
    if (match.pos >= lastEndPos) {
      filtered.push(match);
      lastEndPos = match.pos + match.length;
    }
  }

  // Filter out negated matches
  const nonNegated = filtered.filter(m => !isNegatedMatch(prose, m.pos, m.keyword));

  if (nonNegated.length === 0) {
    return { verdict: null, confidence: null, reason: 'no unambiguous verdict keywords found' };
  }

  // Group by verdict type and find the last occurrence of each
  const verdictGroups: Record<string, (typeof nonNegated)[0] | undefined> = {
    escalate: undefined,
    'request-changes': undefined,
    approve: undefined,
  };

  for (const match of nonNegated) {
    verdictGroups[match.verdictType] = match;
  }

  // Create candidates from verdict types that have matches
  const candidates = Object.entries(verdictGroups)
    .filter(([, match]) => match)
    .map(([verdict, match]) => ({ verdict: verdict as 'escalate' | 'request-changes' | 'approve', match: match! }));

  if (candidates.length === 0) {
    return { verdict: null, confidence: null, reason: 'no unambiguous verdict keywords found' };
  }

  // Sort by position, use the one that appears last
  candidates.sort((a, b) => b.match.pos - a.match.pos);
  const chosen = candidates[0];

  // For prose-extracted verdicts, use conservative confidence scoring.
  // These are fallback extractions when structured output is missing, so they
  // should be gated conservatively to prevent misclassified verdicts from
  // triggering automated actions (like auto-merge or escalation tasks).
  //
  // Confidence is primarily 0.5, with modest adjustments based on position
  // in the prose. A verdict near the conclusion gets slightly higher confidence
  // than one in the middle, but never so high as to bypass the confidence gate
  // with default threshold 0.6.
  const fractionThroughText = chosen.match.pos / prose.length;
  let confidence = 0.5; // Conservative base

  if (fractionThroughText > 0.75) {
    confidence = 0.55; // Slightly higher if near conclusion
  } else if (fractionThroughText > 0.5) {
    confidence = 0.52; // Marginally higher if in final half
  }

  return {
    verdict: chosen.verdict,
    confidence,
    reason: `extracted '${chosen.verdict}' from prose (position ${fractionThroughText.toFixed(2)}, confidence ${confidence.toFixed(2)})`,
  };
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
