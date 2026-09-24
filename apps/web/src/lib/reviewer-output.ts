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

/** The bar an approval must clear when the workspace sets no threshold. */
export const DEFAULT_REVIEW_CONFIDENCE_THRESHOLD = 0.6;

const VERDICTS: ReadonlyArray<ReviewerTaskOutput['verdict']> = ['approve', 'request-changes', 'escalate'];

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
  const o = raw as Record<string, unknown>;
  if (typeof o.verdict !== 'string' || !(VERDICTS as readonly string[]).includes(o.verdict)) {
    return {
      ok: false,
      reason: `verdict must be one of ${VERDICTS.join(', ')} (got ${JSON.stringify(o.verdict ?? null)})`,
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
  return { ok: true, output: o as unknown as ReviewerTaskOutput };
}

/**
 * Turn an approval below the workspace's confidence threshold into an
 * escalation. Every approval posts a GitHub APPROVE and may run the bounded
 * merge into a mission integration branch, so the threshold has to apply to
 * the verdict itself, not only to the unbounded self-merge.
 *
 * Only `approve` is changed: request-changes merges nothing, and escalate is
 * already the outcome this produces.
 */
export function applyConfidenceGate(params: {
  verdict: ReviewerTaskOutput['verdict'];
  confidence: number;
  threshold?: number | null;
}): { verdict: ReviewerTaskOutput['verdict']; overrideReason: string | null } {
  const { verdict, confidence } = params;
  if (verdict !== 'approve') return { verdict, overrideReason: null };
  const threshold = params.threshold ?? DEFAULT_REVIEW_CONFIDENCE_THRESHOLD;
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
