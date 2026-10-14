// @ui-copy: strings here render on the spec page's Delivery and verification section.
/**
 * Delivery and verification, said as sentences (Living Specs Slice 13, R-63).
 * Pure and client-safe: the spec page renders these, the server read
 * (./delivery.ts) decides the inputs.
 *
 * Two things are kept apart on purpose. Delivery: the revision the work was
 * built to and whether it shipped. Standing: where the revision in force now
 * stands for that work. Work built to revision N never reads as proof of
 * revision N+1: once a newer revision is approved, the standing is "not
 * verified" until the work is checked against it again (AC-46). A
 * completed mission or a merged PR is delivery, never a pass.
 *
 * No new status words (AC-48): the words are the ones the task page's spec
 * block already uses (verified, fails, not verified, passed on an older
 * commit), plus "waived" for a criterion a person waived on a mission's
 * outcome spec.
 */

export type DeliveryOutcome = 'verified' | 'fail' | 'unverified';
export type DeliveryTone = 'success' | 'error' | 'muted';

/** A criterion as the drill-down shows it. `waived` comes only from a mission's outcome spec. */
export type CriterionMark = 'pass' | 'fail' | 'stale' | 'none' | 'inconclusive' | 'unsupported' | 'waived';

export interface StandingInput {
  /** The revision the work was built to (its pin). */
  builtTo: number;
  /** The revision in force now; null while nothing is approved. */
  approved: number | null;
  /** The work's governed outcome on its own revision. */
  outcome: DeliveryOutcome;
  /** The criteria on `builtTo`, with how each stands. */
  criteria: ReadonlyArray<{ criterionId: string; mark: CriterionMark }>;
  /** Who waived what, for a mission's outcome spec. */
  waivedBy?: ReadonlyArray<{ criterionId: string; by: string }>;
}

const notVerified = (n: number) => `Not verified against revision ${n}.`;

const list = (ids: readonly string[]) => (ids.length > 4 ? `${ids.slice(0, 4).join(', ')} and ${ids.length - 4} more` : ids.join(', '));

/** Where the revision in force stands for this work, as one or two sentences. */
export function standingSentence(s: StandingInput): { tone: DeliveryTone; text: string } {
  const against = s.approved ?? s.builtTo;
  const waived = waivedSentence(s.waivedBy ?? []);
  const withWaived = (text: string) => (waived ? `${text} ${waived}` : text);
  // Built to an older (or a draft) revision: nothing it recorded speaks for the one in force.
  if (s.approved != null && s.builtTo !== s.approved) {
    return { tone: 'muted', text: notVerified(s.approved) };
  }
  if (s.outcome === 'fail') {
    const failed = s.criteria.filter((c) => c.mark === 'fail').map((c) => c.criterionId);
    return { tone: 'error', text: withWaived(failed.length ? `${list(failed)} fails against revision ${against}.` : `Fails against revision ${against}.`) };
  }
  if (s.outcome === 'verified') return { tone: 'success', text: withWaived(`Verified against revision ${against}.`) };
  const judged = s.criteria.filter((c) => c.mark !== 'waived');
  const allStale = judged.length > 0 && judged.every((c) => c.mark === 'stale' || c.mark === 'pass') && judged.some((c) => c.mark === 'stale');
  if (allStale) return { tone: 'muted', text: withWaived(`Passed on an older commit. ${notVerified(against)}`) };
  return { tone: 'muted', text: withWaived(notVerified(against)) };
}

function waivedSentence(w: ReadonlyArray<{ criterionId: string; by: string }>): string | null {
  if (!w.length) return null;
  const byWho = new Map<string, string[]>();
  for (const x of w) byWho.set(x.by, [...(byWho.get(x.by) ?? []), x.criterionId]);
  return [...byWho].map(([by, ids]) => `${list(ids)} waived by ${by}.`).join(' ');
}

/** The revision the work was built to and whether it shipped. Never a verdict. */
export function deliveredSentence(d: { builtTo: number; provisional: boolean; delivered: boolean }): string {
  const built = d.provisional ? `Built to revision ${d.builtTo} ahead of its approval` : `Built to revision ${d.builtTo}`;
  return `${built} and ${d.delivered ? 'delivered' : 'not delivered'}.`;
}

/** One criterion's mark in the drill-down: the task page's words, plus waived. */
export function criterionWords(mark: CriterionMark): { label: string; tone: DeliveryTone | 'warning' } {
  switch (mark) {
    case 'pass': return { label: 'Passes', tone: 'success' };
    case 'fail': return { label: 'Fails', tone: 'error' };
    case 'stale': return { label: 'Passed on an older commit', tone: 'muted' };
    case 'none': return { label: 'No verdict', tone: 'muted' };
    case 'inconclusive': return { label: 'Inconclusive', tone: 'warning' };
    case 'unsupported': return { label: 'Unsupported', tone: 'warning' };
    case 'waived': return { label: 'Waived', tone: 'muted' };
  }
}

/** A task-page criterion standing as a mark. A stale fail is still a fail; a stale pass is not a pass. */
export function markOf(c: { verdict: 'pass' | 'fail' | 'inconclusive' | 'unsupported' | null; stale: boolean }): CriterionMark {
  if (c.verdict === null) return 'none';
  if (c.verdict === 'pass') return c.stale ? 'stale' : 'pass';
  return c.verdict;
}
