/**
 * The words of a visual review chat event (docs/design/visual-qa-human-review.md,
 * Chat). Pure, so the dev chat fixtures render exactly what the server posts;
 * mission-events.ts does the posting.
 */
import type { ChatVisualReviewEvent, VisualReviewModel } from '@buildd/shared';

/**
 * The moments a mission's visual review posts into its conversation:
 * - `no_browser_runner`: the audit waits with no browser runner online (the stale-workers sweep);
 * - `round_done`: an audit round finished with something left (verdict counts, how many need you);
 * - `fixes_filed`: a human decision filed fixes;
 * - `all_clear`: nothing needs anyone: every screen ok or decided, no fix open;
 * - `round_cap`: issues remain after the last automatic round.
 */
export type VisualReviewMoment = 'no_browser_runner' | 'round_done' | 'fixes_filed' | 'all_clear' | 'round_cap';

/**
 * Where each moment's once-only mark lives on the audit task
 * (`context.visualQa.<key>`). `fixes_filed` has none: every decision that
 * files a fix is its own moment.
 */
export const VISUAL_REVIEW_MOMENT_KEYS = {
  no_browser_runner: 'stallNotifiedAt',
  round_done: 'roundNotifiedAt',
  all_clear: 'clearNotifiedAt',
  round_cap: 'roundCapNotifiedAt',
  fixes_filed: null,
} as const satisfies Record<VisualReviewMoment, string | null>;

export type VisualReviewMomentKey = Exclude<(typeof VISUAL_REVIEW_MOMENT_KEYS)[VisualReviewMoment], null>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Current screens by effective verdict: what the human decided, else the agent. */
function effectiveCounts(model: VisualReviewModel) {
  const s = model.summary;
  const unsure = model.cells.filter(c => c.effectiveVerdict === 'unsure').length;
  return { ok: s.effectiveOk ?? s.ok, issues: s.effectiveIssues ?? s.issues, unsure };
}

function countsLine(model: VisualReviewModel): string {
  const c = effectiveCounts(model);
  return `${c.ok} ok, ${plural(c.issues, 'issue')}, ${c.unsure} unsure`;
}

/** A finished round with nothing left for anyone is the all-clear moment. */
export function roundMomentFor(model: VisualReviewModel): 'round_done' | 'all_clear' {
  return model.phase === 'reviewed' ? 'all_clear' : 'round_done';
}

/**
 * The event's one line. The model reads only this (`[update] text`), so it
 * always carries the counts.
 */
export function visualReviewEventText(
  moment: VisualReviewMoment,
  model: VisualReviewModel,
  extra: { fixes?: number; routes?: readonly string[] } = {},
): string {
  const round = model.audit?.round ?? 1;
  const counts = countsLine(model);
  switch (moment) {
    case 'no_browser_runner':
      return `Visual audit waiting: no browser runner online (${plural(model.summary.shots, 'screen')} captured).`;
    case 'round_done': {
      const n = model.summary.awaitingHuman;
      const tail = n > 0
        ? `${n} ${n === 1 ? 'needs' : 'need'} you.`
        : model.summary.openFixes > 0 ? `${plural(model.summary.openFixes, 'fix', 'fixes')} running.` : 'Nothing needs you.';
      return `Round ${round} done: ${counts}. ${tail}`;
    }
    case 'fixes_filed': {
      const n = extra.fixes ?? 1;
      const routes = extra.routes?.length ? ` (${extra.routes.join(', ')})` : '';
      return `Filed ${plural(n, 'fix', 'fixes')} from your decisions${routes}. ${counts}.`;
    }
    case 'all_clear':
      return `All clear after round ${round}: ${counts}.`;
    case 'round_cap':
      return `Issues remain after ${plural(Math.max(model.summary.rounds, round), 'round')}: your call. ${counts}.`;
  }
}

/** The structured half of the event, for the row's tone and the card. */
export function visualReviewEventData(moment: VisualReviewMoment, model: VisualReviewModel): ChatVisualReviewEvent {
  const c = effectiveCounts(model);
  return {
    phase: moment === 'no_browser_runner' ? 'no_browser_runner' : model.phase,
    round: model.audit?.round ?? 1,
    ok: c.ok,
    issues: c.issues,
    unsure: c.unsure,
    awaitingHuman: model.summary.awaitingHuman,
  };
}
