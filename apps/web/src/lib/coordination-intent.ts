/**
 * Coordination-step intent taxonomy. A planning step whose title matches one
 * of these gets deduped by (mission, intent, subject PR set) instead of by
 * exact title text — see docs/design/task-subject-anchors.md and approve-plan.ts.
 *
 * 'wait' also covers "monitor" phrasing: from the dedupe's point of view,
 * "wait for the budget to reset" and "monitor PR review completion" are the
 * same non-actionable holding pattern — nothing to do but check back later.
 *
 * Kept in sync with `TaskSubjectAnchor['coordinationIntent']` in @buildd/shared.
 */
export type CoordinationIntent = 'wait' | 'aggregate' | 'merge' | 'verify';

// Order matters: a title can match more than one pattern (e.g. "Monitor review
// completion and merge PRs" contains both "monitor" and "merge"). Checked
// top to bottom; the first match wins.
const INTENT_PATTERNS: Array<{ intent: CoordinationIntent; re: RegExp }> = [
  { intent: 'merge', re: /\bmerge(d|s|ing)?\b/i },
  { intent: 'aggregate', re: /\b(aggregate|evaluate mission completion|close mission)\b/i },
  { intent: 'verify', re: /\b(verify|verification)\b/i },
  { intent: 'wait', re: /\b(wait|waiting|monitor|monitoring)\b/i },
];

/** Classify a planned step's title into a coordination intent, or null when it names real work. */
export function classifyCoordinationIntent(title: string): CoordinationIntent | null {
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(title)) return intent;
  }
  return null;
}

const PR_NUMBER_RE = /#(\d+)/g;

/** Sorted, deduped PR numbers named in a coordination step's own text (title + description). */
export function extractPrNumbers(text: string): number[] {
  const numbers = new Set<number>();
  for (const match of text.matchAll(PR_NUMBER_RE)) {
    numbers.add(parseInt(match[1], 10));
  }
  return [...numbers].sort((a, b) => a - b);
}

/** Dedupe key for a coordination step: same intent + same named PRs = same underlying task. */
export function coordinationDedupeKey(intent: CoordinationIntent, prNumbers: number[]): string {
  return `${intent}:${prNumbers.join(',')}`;
}
