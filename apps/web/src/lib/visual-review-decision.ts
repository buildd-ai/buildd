// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * The visual review's decision card (Navigation d25d923d R-16), as data. When
 * a mission's visual review needs a person, the card is built from the
 * review's current state (`VisualReviewModel`), never from the organizer's
 * round-cap note, which describes a moment that has since passed. Pure.
 */
import { VISUAL_REVIEW_MAX_ARTIFACTS, type VisualReviewModel } from '@buildd/shared';
import { SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE } from '@buildd/core/surface-audit';
import { fixCheckDue } from './visual-review-model';
import type { DecisionOption, DecisionView } from './needs-you-card';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const opt = (label: string, effect: string, recommended = false): DecisionOption => ({ label, effect, tip: null, recommended, downstream: null });

/**
 * The round-cap note is the organizer's record of one moment (round N still
 * had issues). Once the review's phase has moved on, or the card below
 * replaces it, the note is stale and not shown. With no review model the
 * note is left alone.
 */
export function withoutStaleRoundCap<T extends { title: string }>(notes: readonly T[], visual: Pick<VisualReviewModel, 'phase'> | null | undefined): T[] {
  if (!visual) return [...notes];
  return notes.filter(n => n.title !== SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE);
}

/** Screens a person waits on: the model's queue, in review order. */
function dueCells(visual: VisualReviewModel) {
  const keys = new Set(visual.queue);
  return visual.cells.filter(c => keys.has(c.key));
}

/** The card for a review that needs a person, or null (the auditor's worker question has its own card). */
export function visualReviewDecision(visual: VisualReviewModel | null | undefined, mission: { id: string; title: string; href: string }): DecisionView | null {
  if (!visual || visual.phase !== 'needs_you' || !visual.needsYou) return null;
  const reason = visual.needsYou.reason;
  if (reason === 'question') return null;
  const due = dueCells(visual);
  const checks = due.filter(fixCheckDue);
  const n = Math.max(due.length, visual.summary.toReview ?? 0, reason === 'fix_check' ? checks.length : 0);

  let summary: string;
  let question: string;
  let options: DecisionOption[];
  let fixed: { artifactIds: string[]; expected: Record<string, string> }[] = [];
  let askedAt: number | null = null;

  if (reason === 'fix_check') {
    const t = Math.max(checks.length, 1);
    summary = `${plural(t, 'fix', 'fixes')} merged with no new screenshot.`;
    question = `Are the ${plural(t, 'fixed screen')} fixed?`;
    options = [
      opt('Mark all fixed', 'Clears the review for these screens', true),
      opt('Review screens →', 'Look at each before opening the merge'),
      opt('Skip the review', 'Merge without a visual check'),
    ];
    const seen = new Set<string>();
    const pairs = checks.flatMap(c => {
      const id = c.current.shot.id;
      if (seen.has(id)) return [];
      seen.add(id);
      return [[id, c.current.agentVerdict] as const];
    });
    for (let i = 0; i < pairs.length; i += VISUAL_REVIEW_MAX_ARTIFACTS) {
      const chunk = pairs.slice(i, i + VISUAL_REVIEW_MAX_ARTIFACTS);
      fixed.push({ artifactIds: chunk.map(p => p[0]), expected: Object.fromEntries(chunk) });
    }
    const merged = checks.map(c => Date.parse(c.fixCheck?.fix.mergedAt ?? '')).filter(Number.isFinite);
    askedAt = merged.length ? Math.max(...merged) : null;
  } else if (reason === 'unsure') {
    const k = Math.max(visual.summary.awaitingHuman, 1);
    summary = `The audit could not judge ${plural(k, 'screen')}.`;
    question = `Do ${k === 1 ? 'this screen' : `these ${k} screens`} look right?`;
    options = [opt('Review screens →', 'Decide each: looks right or needs a fix', true), opt('Skip the review', 'Merge without a visual check')];
  } else {
    const k = Math.max(visual.summary.effectiveIssues, 1);
    summary = `Issues remain on ${plural(k, 'screen')} after the automatic rounds.`;
    question = 'Fix the remaining screens or ship as is?';
    options = [opt('Review screens →', 'Mark each fixed or send it back', true), opt('Skip the review', 'Merge without a visual check')];
  }
  if (askedAt == null) askedAt = Date.parse(visual.audit?.endedAt ?? '') || null;

  return {
    key: `visual-review:${mission.id}:${reason}`,
    kind: 'decision',
    task: null,
    mission,
    label: 'Visual review',
    askedAt,
    summary,
    question,
    options,
    waits: null,
    diffHref: null,
    answer: { kind: 'visual', missionId: mission.id, reviewHref: mission.href, markFixed: fixed, startKey: visual.queue[0] ?? null },
    shortcut: false,
  };
}
