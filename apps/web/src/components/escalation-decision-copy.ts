/**
 * What the task page says about a review escalation (spec r7 §7, AC-43 / AC-48),
 * from the kernel's escalation brief (`deriveEscalationBrief`) and the delivery's
 * rounds and attempt ledger. Pure, so the verdict row, the decision card and its
 * tests read one wording.
 *
 * - It leads with the question, then says why automation stopped, in words.
 * - It names every unresolved finding instead of counting them.
 * - It offers Review findings plus only the actions this person may take now and
 *   the page can carry out. Approving past findings is never offered from here:
 *   no route on this page records it, so a button would promise an approval it
 *   cannot back. The routes re-check access on every request.
 */
import type { EscalationAction, EscalationActionId, EscalationBrief } from '@buildd/workflow-kernel/escalation-brief';
import type { AttemptSnapshot, RoundSnapshot } from '@buildd/workflow-kernel/types';

/** The actions this page can carry out (EscalationDecision's handlers). */
export const HANDLED_ACTIONS: ReadonlySet<EscalationActionId> = new Set(['review_findings', 'request_fix', 'force_re_review']);

export interface DecisionCopy {
  /** The heading: what the person is asked to decide. */
  question: string;
  /** Why nothing runs on its own any more. */
  why: string;
  /** Unresolved findings by title. */
  unresolved: { open: string[]; awaitingVerification: string[] };
  /** Resolved findings, by title, for the findings list. */
  resolved: string[];
  /** Review findings first, then what this person may do. Every one is available. */
  actions: EscalationAction[];
  /** The one action the verdict row's button names. */
  primary: EscalationAction;
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const word = (n: number): string => WORDS[n] ?? String(n);
const many = (n: number, one: string, more = `${one}s`) => `${word(n)} ${n === 1 ? one : more}`;

export function decisionCopy(brief: EscalationBrief, ctx: { rounds: readonly RoundSnapshot[]; ledger: readonly AttemptSnapshot[] }): DecisionCopy {
  const open = brief.findings.open.map((f) => f.title);
  const awaiting = brief.findings.addressedAwaitingVerification.map((f) => f.title);
  const remaining = open.length + awaiting.length;

  const question = remaining === 0
    ? 'How should this PR go forward?'
    : remaining === 1 ? 'How should the unresolved finding be settled?' : `How should the ${word(remaining)} unresolved findings be settled?`;

  const rounds = ctx.rounds.filter((r) => r.status !== 'superseded').length;
  const fixes = ctx.ledger.filter((a) => a.family === 'review_fix' && a.mode === 'agent' && a.status !== 'skipped').length;
  const after = `Automation stopped after ${many(rounds, 'review round')}`;
  const reason = brief.cause === 'fixes_exhausted'
    ? `${fixes === 2 ? 'both automatic fixes' : fixes === 1 ? 'the automatic fix' : `all ${word(fixes)} automatic fixes`} ran and the review still asks for changes`
    : awaiting.length > 0 && open.length === 0
      ? `${awaiting.length === 1 ? 'a fix was' : 'fixes were'} pushed, and no review round is left to check ${awaiting.length === 1 ? 'it' : 'them'}`
      : 'no automatic review can settle this PR';
  const why = `${after}: ${reason}. Nothing runs again until someone chooses.`;

  const actions = brief.actions.filter((a) => a.available && HANDLED_ACTIONS.has(a.id));
  const pick = (id: EscalationActionId) => actions.find((a) => a.id === id);
  // review_findings is always available, so a primary always exists.
  const primary = pick('request_fix') ?? pick('force_re_review') ?? pick('review_findings')!;

  return {
    question, why,
    unresolved: { open, awaitingVerification: awaiting },
    resolved: brief.findings.resolved.map((f) => f.title),
    actions, primary,
  };
}

const HASH_PREFIX = '#task-decision-';

/** The verdict row's link: scrolls to the decision card and opens that action's confirmation. */
export const decisionActionHref = (id: EscalationActionId): string => `${HASH_PREFIX}${id}`;

/** The action a hash asks the card to open, or null. */
export function parseDecisionHash(hash: string): EscalationActionId | null {
  if (!hash.startsWith(HASH_PREFIX)) return null;
  const id = hash.slice(HASH_PREFIX.length) as EscalationActionId;
  return HANDLED_ACTIONS.has(id) ? id : null;
}
