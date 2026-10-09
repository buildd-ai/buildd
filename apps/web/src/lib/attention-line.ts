/**
 * The decision a reviewer escalation asks of a person, in one line, plus the
 * structured reasons behind it. Pure and client-safe: the Home review cards
 * render from it, and reviewer-gate / pr-review-status parse into it.
 *
 * A reviewer row written before `blockers` existed has only free text; every
 * reader here degrades to "no blockers" and the first sentence of that text.
 */

export const REVIEW_BLOCKER_KINDS = [
  'policy_gate',
  'migration',
  'merge_conflict',
  'ci',
  'correctness',
  'security',
  'scope',
  'unverified',
  'other',
] as const;
export type ReviewBlockerKind = (typeof REVIEW_BLOCKER_KINDS)[number];

export interface ReviewBlocker {
  kind: ReviewBlockerKind;
  text: string;
}

const BLOCKER_LABEL: Record<ReviewBlockerKind, string> = {
  policy_gate: 'needs a person',
  migration: 'migration',
  merge_conflict: 'merge conflict',
  ci: 'ci',
  correctness: 'correctness',
  security: 'security',
  scope: 'scope',
  unverified: 'not verified',
  other: 'other',
};

export function blockerLabel(kind: ReviewBlockerKind): string {
  return BLOCKER_LABEL[kind];
}

export function parseReviewBlockers(raw: unknown): ReviewBlocker[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewBlocker[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { kind, text } = entry as Record<string, unknown>;
    if (typeof text !== 'string' || text.trim().length === 0) continue;
    out.push({
      kind: REVIEW_BLOCKER_KINDS.includes(kind as ReviewBlockerKind) ? (kind as ReviewBlockerKind) : 'other',
      text: text.trim(),
    });
  }
  return out;
}

const DECISION_MAX = 140;

/** The first sentence of free text, capped. A dot inside `a.ts` is not a sentence end. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](?=\s|$)/);
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length > DECISION_MAX ? `${sentence.slice(0, DECISION_MAX).trimEnd()}…` : sentence;
}

/** What the card leads with: the reviewer's next step, else the reason's first sentence. */
export function reviewDecisionLine(input: { recommendation?: string | null; reason: string }): string {
  const rec = input.recommendation?.trim();
  return firstSentence(rec ? rec : input.reason);
}
