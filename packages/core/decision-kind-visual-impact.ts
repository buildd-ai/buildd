/**
 * `buildd.visual_impact`: does this change need a visual review? A first-party
 * decision kind on the shared substrate (`decision-kinds.ts`,
 * `decision-policy.ts`). It owns the decision contract only; reading the
 * mission branch diff, the deterministic rules and the workspace policy stay in
 * `apps/web/src/lib/workflow/visual-review-impact.ts`.
 *
 * - **Output**: `review_required | no_visual_impact | insufficient_evidence`,
 *   with a closed structured reason in the reason code (`reason_<reason>`).
 * - **Override**: a protected / high-risk hit the rules already found is
 *   `review_required`, in every rollout mode. No model is asked about it.
 * - **Fail-safe fallback**: nothing decided (no route, error, low confidence,
 *   unparseable features) is `review_required`. A model that cannot answer
 *   never lets a change skip its review. The consumer also treats
 *   `insufficient_evidence` as `review_required`.
 * - **Not a waiver**: `no_visual_impact` is an applicability answer about the
 *   change. Waivers are a person's recorded decision and live elsewhere.
 *
 * Features are bounded counters and closed enums: no paths, no code, no text.
 */

import { choice } from '@builddai/ai-kit/decide';
import type { DecisionKindConfig, FeatureParse } from '@builddai/ai-kit/decide';
import { defineBuilddDecisionKind, type BuilddDecisionKindBinding } from './decision-kinds';

export const VISUAL_IMPACT_KIND = 'buildd.visual_impact' as const;

export const VISUAL_IMPACT_DECISIONS = ['review_required', 'no_visual_impact', 'insufficient_evidence'] as const;
export type VisualImpactDecision = (typeof VISUAL_IMPACT_DECISIONS)[number];

export const VISUAL_IMPACT_REASONS = ['markup_changed', 'style_changed', 'copy_changed', 'logic_only', 'unclear'] as const;
export type VisualImpactReason = (typeof VISUAL_IMPACT_REASONS)[number];

const MAX_COUNT = 100_000;

export interface VisualImpactFeatures {
  /** The deterministic rules matched a protected / high-risk surface. */
  protectedHit: boolean;
  totalFiles: number;
  /** Files near the UI the rules could not rule out. */
  candidateFiles: number;
  /** Candidate files whose diff text was not available. */
  candidatesWithoutPatch: number;
  addedLines: number;
  removedLines: number;
  /** Changed lines that read as markup (JSX / HTML tags). */
  markupLines: number;
  /** Changed lines that set class names or inline styles. */
  styleLines: number;
  /** Changed lines that read as user-visible text. */
  textLines: number;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function parseVisualImpactFeatures(input: unknown): FeatureParse<VisualImpactFeatures> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'features must be an object' };
  const f = input as Record<string, unknown>;
  if (typeof f.protectedHit !== 'boolean') return { ok: false, message: 'protectedHit must be a boolean' };
  const counts = ['totalFiles', 'candidateFiles', 'candidatesWithoutPatch', 'addedLines', 'removedLines', 'markupLines', 'styleLines', 'textLines'] as const;
  for (const k of counts) if (!isCount(f[k])) return { ok: false, message: `${k} must be a non-negative number` };
  const c = (k: (typeof counts)[number]) => Math.min(Math.round(f[k] as number), MAX_COUNT);
  return {
    ok: true,
    features: {
      protectedHit: f.protectedHit,
      totalFiles: c('totalFiles'),
      candidateFiles: c('candidateFiles'),
      candidatesWithoutPatch: c('candidatesWithoutPatch'),
      addedLines: c('addedLines'),
      removedLines: c('removedLines'),
      markupLines: c('markupLines'),
      styleLines: c('styleLines'),
      textLines: c('textLines'),
    },
  };
}

const questions = {
  decision: choice(
    'A mission changed files near a web app\'s user interface. From these counts alone, would anything a person sees on screen look different, so that screenshots should be reviewed?',
    {
      review_required: 'Something visible probably changed: markup, styling or text',
      no_visual_impact: 'The counts show only logic or data changes; nothing on screen would move',
      insufficient_evidence: 'The counts cannot tell',
    },
  ),
  reason: choice('What is the main reason?', {
    markup_changed: 'Markup or component structure changed',
    style_changed: 'Class names or styles changed',
    copy_changed: 'User-visible text changed',
    logic_only: 'Only behaviour or data handling changed',
    unclear: null,
  }),
};

export const VISUAL_IMPACT_CONFIG: DecisionKindConfig<
  typeof VISUAL_IMPACT_KIND, VisualImpactFeatures, VisualImpactDecision, typeof questions
> = {
  kind: VISUAL_IMPACT_KIND,
  policyVersion: 'vimp-2026-10-12.a',
  featureSchemaVersion: 'vimp-features-v1',
  decisions: VISUAL_IMPACT_DECISIONS,
  parseFeatures: parseVisualImpactFeatures,
  override: f => (f.protectedHit ? { decision: 'review_required', reasonCode: 'protected_surface' } : null),
  questions,
  state: ({ protectedHit: _p, ...signals }) => signals,
  interpret: a => ({
    decision: a.decision.choice,
    confidence: a.decision.confidence,
    reasonCode: `reason_${a.reason.choice}`,
  }),
  // Not yet measured on a held-out set; skipping a review needs a confident answer.
  minConfidence: 0.85,
  // Every fallback runs the review: not knowing never skips it.
  fallback: (_f, cause) => ({ decision: 'review_required', reasonCode: `fallback_${cause}` }),
};

/** Live once its capability is on; the fallback is the safe answer. Rollback: `mode: 'shadow'`. */
export const VISUAL_IMPACT_BINDING: BuilddDecisionKindBinding = {
  capability: 'visual_impact',
  mode: 'live',
};

export const visualImpactKind = defineBuilddDecisionKind(VISUAL_IMPACT_CONFIG, VISUAL_IMPACT_BINDING);

/** The structured reason a response carries, or null (rules and fallbacks carry none). */
export function visualImpactReasonOf(reasonCode: string): VisualImpactReason | null {
  const m = /^reason_(.+)$/.exec(reasonCode);
  return m && (VISUAL_IMPACT_REASONS as readonly string[]).includes(m[1]) ? (m[1] as VisualImpactReason) : null;
}
