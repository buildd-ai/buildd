/**
 * The "Final screens" gallery's read of a visual review: the latest shot per
 * route × viewport × theme, from every round's shots. Pure and read-only.
 *
 * It is a record of how the screens ended up, never a gate: nothing here
 * reads a verdict into a blocker, a count or a phase. A screen whose route
 * opened a dialog or panel (`qa.state`) is its own screen, so it does not
 * replace the page as it loads.
 */
import type { VisualQaVerdict, VisualQaViewport, VisualReviewModel } from '@buildd/shared';

export interface FinalScreen {
  /** `route|viewport|theme|state`. */
  key: string;
  route: string;
  viewport: VisualQaViewport;
  /** `default` when the shot carried none. */
  theme: string;
  state: string | null;
  shotId: string;
  src: string;
  createdAt: string;
  agentVerdict: VisualQaVerdict;
  finding: string;
  /** A fix already filed for this screen (auditor's or a person's). */
  fixTaskId: string | null;
}

export const DEFAULT_THEME = 'default';

const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

export function finalScreens(model: Pick<VisualReviewModel, 'cells'> | null | undefined): FinalScreen[] {
  if (!model) return [];
  const best = new Map<string, FinalScreen & { round: number }>();
  for (const cell of model.cells) {
    for (const entry of cell.history.length ? cell.history : [cell.current]) {
      const qa = entry.shot.qa;
      const theme = qa.theme?.trim().toLowerCase() || DEFAULT_THEME;
      const state = qa.state ?? null;
      const key = `${cell.route}|${cell.viewport}|${theme}|${state ?? ''}`;
      const prev = best.get(key);
      const at = time(entry.shot.createdAt);
      if (prev && (time(prev.createdAt) > at || (time(prev.createdAt) === at && prev.round >= entry.round))) continue;
      best.set(key, {
        key,
        route: cell.route,
        viewport: cell.viewport,
        theme,
        state,
        shotId: entry.shot.id,
        src: entry.shot.src,
        createdAt: entry.shot.createdAt,
        agentVerdict: entry.agentVerdict,
        finding: entry.finding,
        fixTaskId: entry.review?.fixTaskId ?? entry.fixTask?.id ?? qa.fixTaskId ?? null,
        round: entry.round,
      });
    }
  }
  return [...best.values()]
    .map(({ round: _round, ...s }) => s)
    .sort((a, b) => a.route.localeCompare(b.route) || a.viewport.localeCompare(b.viewport) || a.theme.localeCompare(b.theme) || (a.state ?? '').localeCompare(b.state ?? ''));
}
