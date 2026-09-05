import { NOT_WINNING_ORDER, VERDICT_LABEL, type Verdict } from './verdict-presentation';

/**
 * Clause assembly for Home's one-line initiative pulse
 * (`docs/specs/surface-ia-home-missions-initiatives.md` §2.2).
 *
 * Pure, and deliberately free of any database import so the line can be built
 * on either side of the client boundary. It consumes verdicts — it never derives
 * one: the ladder lives in `initiative-pulse.ts` and there is exactly one of it
 * (§6.2, "one loader, three callers").
 *
 * Clauses count **initiatives by verdict**, never PRs or missions. §2.3 is the
 * reasoning: the Waiting-on-You queue directly below the line already lists every
 * awaiting-merge PR as its own `MERGE` card, so a merge count here would restate
 * the rows it sits above and the two numbers would drift the moment the queue's
 * dedup dropped one.
 */

/**
 * Clause order is fixed and is the ladder's own order:
 * losing → grinding → stuck → ready to close. `NOT_WINNING_ORDER` is that order,
 * shared with the Initiatives list's zones so the two cannot diverge.
 */
export const PULSE_CLAUSE_ORDER: readonly Verdict[] = NOT_WINNING_ORDER;

/** One arc's contribution to the line. No PR, merge or review fields — by design. */
export interface PulseLineItem {
  id: string;
  title: string;
  verdict: Verdict;
}

export interface InitiativePulseLine {
  /** `Initiatives`, or the arc's own title when exactly one contributes (§2.2). */
  prefix: string;
  /** Non-zero clauses in ladder order, e.g. `['2 losing', '1 ready to close']`. */
  clauses: string[];
  /** `/app/initiatives`, or `/app/initiatives/<id>` for a single contributor. */
  href: string;
  /** `<prefix> · <clause> · …` — the whole line, minus the trailing arrow. */
  text: string;
}

/** The clause word for a verdict, taken from the one spelling of its label. */
function clauseWord(verdict: Verdict): string {
  return VERDICT_LABEL[verdict].toLowerCase();
}

/**
 * Build the pulse line, or `null` when there is nothing to say.
 *
 * `winning`, `dormant` and `empty` contribute no clause, so a team that is
 * winning everywhere gets no line at all — no label, no header, no "nothing to
 * see" text. Returning `null` rather than an empty shape is what lets the caller
 * render absence instead of empty chrome; that is the whole point of the line
 * (§2.2): it fires only when the answer to *are we winning* is no.
 */
export function buildInitiativePulseLine(items: PulseLineItem[]): InitiativePulseLine | null {
  const contributors = items.filter((item) => PULSE_CLAUSE_ORDER.includes(item.verdict));
  if (contributors.length === 0) return null;

  const clauses: string[] = [];
  for (const verdict of PULSE_CLAUSE_ORDER) {
    const n = contributors.filter((item) => item.verdict === verdict).length;
    if (n > 0) clauses.push(`${n} ${clauseWord(verdict)}`);
  }

  // "Exactly one initiative contributes every clause" is by identity, not by
  // count: two arcs that happen to share a title are still two arcs, so the line
  // stays generic and links to the list.
  const contributingIds = new Set(contributors.map((item) => item.id));
  const sole = contributingIds.size === 1 ? contributors[0] : null;

  const prefix = sole ? sole.title : 'Initiatives';
  return {
    prefix,
    clauses,
    href: sole ? `/app/initiatives/${sole.id}` : '/app/initiatives',
    text: [prefix, ...clauses].join(' · '),
  };
}
