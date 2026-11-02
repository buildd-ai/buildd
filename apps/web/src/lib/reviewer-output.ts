/**
 * Server-side validation of a reviewer's structured verdict, and the
 * confidence bar an approval must clear.
 *
 * Kept free of DB and GitHub imports so the worker PATCH route can use the
 * real implementation in its tests; `reviewer.ts` pulls in the whole task
 * creation graph.
 *
 * Why validate here at all: the output schema is requested from the agent,
 * but `complete_task` passes structuredOutput through unchanged and the Codex
 * backend checks only top-level keys. An out-of-enum verdict used to fall
 * through the outcome switch with no action, which reads as `review_failed`
 * and lets the merge gate pass; a string confidence threw at `.toFixed`.
 */

import type { ReviewerTaskOutput } from './reviewer';
import { isApprovalSelfMergeable } from './pr-review-status';
import { checkRemedyFindings } from './reviewer-remedy';

/** The bar an approval must clear when the workspace sets no threshold. */
export const DEFAULT_REVIEW_CONFIDENCE_THRESHOLD = 0.6;

export const REVIEWER_VERDICTS: ReadonlyArray<ReviewerTaskOutput['verdict']> = ['approve', 'request-changes', 'escalate'];
const VERDICTS = REVIEWER_VERDICTS;

/**
 * Map a spelling variant of a canonical verdict (request_changes,
 * requestChanges, REQUEST-CHANGES, "request changes") to the canonical value.
 * Only case and word separators are normalized — a different word
 * ("approved", "reject") is not an obvious variant and stays unrecognized.
 */
export function normalizeReviewerVerdict(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const canonical = raw
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_-]+/g, '-')
    .toLowerCase();
  return (VERDICTS as readonly string[]).includes(canonical) ? canonical : raw;
}

export type ParsedReviewerOutput =
  | { ok: true; output: ReviewerTaskOutput }
  | { ok: false; reason: string };

/**
 * Validate a reviewer's structuredOutput against the verdict contract:
 * verdict in the enum, confidence a finite number in [0, 1] (rejected, never
 * rescaled or coerced), summary a string. Optional fields pass through as-is.
 */
export function parseReviewerOutput(raw: unknown): ParsedReviewerOutput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'structuredOutput is not an object' };
  }
  const o = { ...(raw as Record<string, unknown>) };
  o.verdict = normalizeReviewerVerdict(o.verdict);
  if (typeof o.verdict !== 'string' || !(VERDICTS as readonly string[]).includes(o.verdict)) {
    return {
      ok: false,
      reason: `verdict must be exactly one of ${VERDICTS.map((v) => `"${v}"`).join(', ')} (got ${JSON.stringify(o.verdict ?? null)})`,
    };
  }
  if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) {
    return {
      ok: false,
      reason: `confidence must be a number from 0 to 1 (got ${JSON.stringify(o.confidence ?? null)})`,
    };
  }
  if (typeof o.summary !== 'string') {
    return { ok: false, reason: 'summary must be a string' };
  }
  const remedy = checkRemedyFindings({ verdict: o.verdict, findings: o.findings });
  if (!remedy.ok) return { ok: false, reason: remedy.reason };
  return { ok: true, output: o as unknown as ReviewerTaskOutput };
}

/**
 * Apply confidence gates to reviewer verdicts.
 *
 * For `approve`: verdicts below the workspace's confidence threshold are
 * downgraded to escalation (human review needed). Every approval posts a GitHub
 * APPROVE and may run the bounded merge into a mission integration branch, so
 * the threshold has to apply to the verdict itself.
 *
 * For `request-changes` and `escalate` from prose extraction: these verdicts
 * with low confidence (from fallback extraction) are escalated for human
 * confirmation rather than acting immediately. This prevents misclassified
 * verdicts (e.g., "I considered changes but I approve" → misextracted as
 * `request-changes`) from triggering unwanted automated actions like builder
 * fix-retry or PR escalation.
 *
 * The threshold applies uniformly: verdicts below it are escalated, those at
 * or above it pass through.
 */
export function applyConfidenceGate(params: {
  verdict: ReviewerTaskOutput['verdict'];
  confidence: number;
  threshold?: number | null;
}): { verdict: ReviewerTaskOutput['verdict']; overrideReason: string | null } {
  const { verdict, confidence } = params;
  const threshold = params.threshold ?? DEFAULT_REVIEW_CONFIDENCE_THRESHOLD;

  if (verdict === 'approve') {
    // The same predicate the self-merge paths use, so "clears the bar" has one
    // definition.
    if (isApprovalSelfMergeable({ verdict: 'approve', confidence, merged: false }, threshold)) {
      return { verdict, overrideReason: null };
    }
    return {
      verdict: 'escalate',
      overrideReason: `confidence ${confidence.toFixed(2)} below workspace threshold ${threshold.toFixed(2)}`,
    };
  }

  // For request-changes and escalate: also apply the confidence gate.
  // Low-confidence verdicts from prose extraction should be escalated for human
  // confirmation rather than acting immediately.
  if (confidence < threshold) {
    return {
      verdict: 'escalate',
      overrideReason: `${verdict} confidence ${confidence.toFixed(2)} below workspace threshold ${threshold.toFixed(2)} (escalated for human review)`,
    };
  }

  return { verdict, overrideReason: null };
}

/**
 * The commit the reviewer reported its checkout at (`checkoutSha`), trimmed and
 * lowercased, or null when it reported none. Only an exact match of the head
 * counts as evidence of it (`applyEvidenceGate`): a short SHA does not.
 */
export function reviewerEvidenceSha(output: unknown): string | null {
  const raw = output && typeof output === 'object' ? (output as { checkoutSha?: unknown }).checkoutSha : undefined;
  if (typeof raw !== 'string') return null;
  const sha = raw.trim().toLowerCase();
  return sha.length > 0 && sha.length <= 64 ? sha : null;
}

/**
 * A verdict counts only when the reviewer read the head it was asked about. One
 * whose evidence is another commit (its worktree sat at the base, say) or none is
 * inconclusive: whatever it said, it never approves, and goes to a person.
 */
export function applyEvidenceGate(params: {
  verdict: ReviewerTaskOutput['verdict'];
  evidenceSha: string | null;
  headSha: string;
}): { verdict: ReviewerTaskOutput['verdict']; overrideReason: string | null } {
  const head = params.headSha.trim().toLowerCase();
  if (params.evidenceSha !== null && params.evidenceSha === head) return { verdict: params.verdict, overrideReason: null };
  const read = params.evidenceSha ? `commit ${params.evidenceSha.slice(0, 7)}` : 'no reported checkout';
  return {
    verdict: 'escalate',
    overrideReason: `inconclusive: the reviewer judged ${read}, not the head ${head.slice(0, 7)}`,
  };
}

const VERDICT_WORDS: Record<ReviewerTaskOutput['verdict'], string> = {
  approve: 'approve',
  'request-changes': 'request changes',
  escalate: 'escalate',
};

/**
 * The summary a verdict is shown with once the server's gates have settled it (f8a7a088). The
 * reviewer's own sentence was written for its own verdict: on an approve the design gate held as
 * request-changes it reads "the prior approve stands", beside a verdict that says the opposite.
 * So when a gate changed the verdict, the summary says what settled it, and the reviewer's
 * sentence is kept apart (`reviewerSummary`), never shown as the verdict's. Unchanged verdicts
 * keep the reviewer's summary.
 */
export function settledSummary(params: {
  said: ReviewerTaskOutput['verdict'];
  settled: ReviewerTaskOutput['verdict'];
  reason: string | null;
  summary: string;
}): { summary: string; reviewerSummary: string | null } {
  if (params.said === params.settled) return { summary: params.summary, reviewerSummary: null };
  const reason = params.reason?.trim().replace(/[.\s]+$/, '');
  return {
    summary: `buildd held the reviewer's ${VERDICT_WORDS[params.said]} as ${VERDICT_WORDS[params.settled]}${reason ? `: ${reason}` : ''}.`,
    reviewerSummary: params.summary,
  };
}
