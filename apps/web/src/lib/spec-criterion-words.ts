// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * A spec requirement in words, the one helper every surface that names one
 * reads: the criteria decision card's summary, the Verify row, the check row.
 * A requirement is named by its own text, shortened to its first clause, and
 * never by its id (Navigation R-20: names, never ids).
 *
 * Pure. The texts come from `spec_criteria` (`lib/specs/criterion-texts.ts`).
 */
import type { GoalCriteriaState, GoalCriterion } from '@buildd/shared';
import { isStandardCriterion } from '@buildd/core/mission-helpers';
import { criterionLabel } from './goal-criterion-label';
import { outcomeSpecView, type OpenStanding } from './mission-outcome-spec-view';

/** The key a spec criterion's text is held under: two specs may both have an R-1. */
export const criterionTextKey = (specId: string, criterionId: string) => `${specId}:${criterionId}`;

const NAME_MAX = 48;

/** The requirement's first clause, without markdown or a leading id, clipped at a word. */
export function criterionShortName(text: string, max = NAME_MAX): string {
  let s = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:R|AC)-\d+[a-z]?\s*[:.)-]?\s*/i, '');
  // The first clause: up to a sentence end, a comma, a colon or a dash between words.
  const cut = /(?:[.;:!?](?:\s|$)|,\s| [-–—] |\s\()/.exec(s);
  if (cut && cut.index > 0) s = s.slice(0, cut.index);
  s = s.replace(/[.;:,]+$/, '').trim();
  if (s.length <= max) return s;
  const clipped = s.slice(0, max - 1);
  const space = clipped.lastIndexOf(' ');
  return `${(space > max / 2 ? clipped.slice(0, space) : clipped).replace(/[\s,;:.]+$/, '')}…`;
}

/**
 * What the open requirements have in common, as words after `N requirements`:
 * the spec row's results (`CriterionLine`), so a check that could not run
 * reads `not checked` on both.
 */
const STATE_WORDS: Record<OpenStanding, string> = {
  fail: 'not met',
  missing: 'not checked',
  stale: 'out of date',
  inconclusive: 'not checked',
  unsupported: 'not checked',
};

export interface UnmetRequirements {
  count: number;
  /** `not checked`, `not met`, …; `not passing` when they differ. */
  state: string;
  /** In the order given; a requirement whose text is unknown is counted but not named. */
  names: string[];
}

/** The open requirements of one or more specs, named from their texts (criterion id → text). */
export function unmetRequirements(input: {
  open: readonly { standing: OpenStanding; criterionIds: readonly string[] }[];
  texts: ReadonlyMap<string, string>;
}): UnmetRequirements {
  const groups = input.open.filter(g => g.criterionIds.length > 0);
  const ids = groups.flatMap(g => g.criterionIds);
  const states = new Set(groups.map(g => STATE_WORDS[g.standing]));
  return {
    count: ids.length,
    state: states.size === 1 ? [...states][0] : 'not passing',
    names: ids.flatMap(id => {
      const text = input.texts.get(id);
      return text ? [criterionShortName(text)] : [];
    }),
  };
}

/** Two sentences: which requirements, then what waits on them. `4 requirements not checked: A, B, C and 1 more. The mission finishes…` */
export function unmetSummary(u: UnmetRequirements, shown = 3): string {
  const one = u.count === 1;
  const head = `${u.count} ${one ? 'requirement' : 'requirements'} ${u.state}`;
  const names = u.names.slice(0, shown);
  const rest = u.count - names.length;
  const list = names.length === 0 ? '' : `: ${names.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`;
  return `${head}${list}. The mission finishes once ${one ? 'it passes or is waived' : 'these pass or are waived'}.`;
}

/**
 * Every requirement the mission's goal criteria still hold open, in words: a
 * spec's open criteria by their own texts, every in-scope one when the spec
 * was never checked, and any other criterion by its label. A spec criterion's
 * words are the ones kept with its evaluation (`CriterionLine.text`, the spec
 * row's source), else `texts` (from `spec_criteria`, keyed by
 * `criterionTextKey`). Standards and passing criteria are left out. Null when
 * none is open.
 */
export function goalCriteriaUnmet(input: {
  criteria: readonly GoalCriterion[];
  state: GoalCriteriaState | null | undefined;
  texts: ReadonlyMap<string, string>;
}): UnmetRequirements | null {
  const open: { standing: OpenStanding; criterionIds: string[] }[] = [];
  const texts = new Map(input.texts);
  input.criteria.forEach((c, i) => {
    const entry = input.state?.criteria.find(e => e.index === i) ?? null;
    if (isStandardCriterion(c) || entry?.standard || entry?.verdict === 'pass') return;
    if (c.type === 'living_spec') {
      const view = outcomeSpecView(c, entry);
      for (const line of view.criteria) if (line.text) texts.set(criterionTextKey(c.specId, line.id), line.text);
      if (view.total > 0) {
        for (const g of view.open) open.push({ standing: g.standing, criterionIds: g.criterionIds.map(id => criterionTextKey(c.specId, id)) });
        return;
      }
      // Never checked: every requirement in scope, in the spec's order.
      const prefix = criterionTextKey(c.specId, '');
      const waived = new Set((c.waived ?? []).map(w => w.criterionId));
      const ids = [...input.texts.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length))
        .filter(id => !waived.has(id) && (!c.criteria || c.criteria.includes(id)));
      open.push({ standing: 'missing', criterionIds: ids.map(id => criterionTextKey(c.specId, id)) });
      return;
    }
    const key = `goal:${i}`;
    texts.set(key, criterionLabel(c));
    open.push({ standing: entry?.verdict === 'fail' ? 'fail' : 'missing', criterionIds: [key] });
  });
  const u = unmetRequirements({ open, texts });
  return u.count > 0 ? u : null;
}
