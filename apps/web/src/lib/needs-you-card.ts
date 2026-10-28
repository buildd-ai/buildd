// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * The one decision card (Navigation d25d923d R-16), as data. A decision or
 * approval a person must give reads the same on the mission page, the task
 * page and Home: the task it belongs to and its age, why and what waits on it
 * by name, the decision as a question, a primary option and one alternative
 * each with its one-line effect (and a fuller tip for desktop hover), then
 * `Answer differently` and `Not now`.
 *
 * Pure. Each surface builds a `DecisionView` from what it already holds (a
 * parked worker's `waitingFor`, an organizer's open question note, a delivery
 * waiting on a person) and `components/DecisionCard.tsx` draws it. Nothing
 * here reads the database.
 *
 * What waits on the decision is never built here or by a surface: it is the
 * one `QuestionWaits` the projection computes (lib/question-waits.ts, Living
 * Spec 1b257609 R-5), passed in as `waits`. The card renders its summary
 * clause, footer line and option effects from it
 * (packages/core/question-waits.ts).
 */
import type { UnifiedQuestion } from '@/app/app/(protected)/tasks/[id]/question-hero';
import { effectFor, type QuestionWaits } from '@buildd/core/question-waits';

export type DecisionKind = 'decision' | 'approval';

export interface DecisionOption {
  label: string;
  /** One line, visible on the button: what choosing it leads to. */
  effect: string | null;
  /** The fuller line, shown above the button on desktop hover or focus. Null when `effect` says it all. */
  tip: string | null;
  recommended: boolean;
  /** What the option's outcome kind does to the waiting work (`Finishes the task: B starts`). Null without a kind. */
  downstream: string | null;
}

/** How an answer is recorded; the card posts, the surface refreshes. */
export type DecisionAnswer =
  /** A parked worker: `/api/workers/[id]/respond`, marking its question note too. */
  | { kind: 'worker'; workerId: string; taskId: string | null; noteId: string | null }
  /** An organizer's question note: the mission's note reply route. */
  | { kind: 'note'; missionId: string; noteId: string }
  /** An approval decided where the work is (the PR): the buttons are links. */
  | { kind: 'link'; primaryHref: string; secondaryHref: string }
  /**
   * A mission's visual review waiting on a person: options are `Mark all
   * fixed` (decide each listed screen looks right) and `Review screens` (opens
   * the per-screen deck, or goes to the mission). `skips` are the two Skip
   * choices (the review is wrong or stuck, ship it anyway), offered under
   * Answer differently.
   */
  | { kind: 'visual'; missionId: string; reviewHref: string; markFixed: { artifactIds: string[]; expected: Record<string, string> }[]; startKey: string | null; skips: string[] }
  /**
   * The mission's goal-criteria escalation: the primary option files the work
   * (a link), the alternative waives and completes (a PATCH on the mission).
   * Answer differently files the person's words as a task on the mission in
   * `workspaceId` (filing work is what clears the escalation); null hides it.
   */
  | { kind: 'criteria'; missionId: string; workspaceId: string | null; fileWorkHref: string };

export interface DecisionView {
  key: string;
  kind: DecisionKind;
  /** The task the decision belongs to. Null: the decision is about the mission itself. */
  task: { id: string; title: string; href: string } | null;
  /** Named when the card falls back to the mission (an organizer decision with no subject task). */
  mission: { id: string; title: string; href: string } | null;
  /** Names the subject when there is no task or mission to link (or the page is that mission's own). */
  label?: string | null;
  /** When it was asked, epoch ms; null when unknown. */
  askedAt: number | null;
  /** Why, in the agent's (or the delivery's) words. Body text; null when nothing is known. */
  summary: string | null;
  /**
   * What waits on the decision, from the projection: the card adds its
   * summary clause and footer line. Null where nothing was computed.
   */
  waits: QuestionWaits | null;
  /** The decision as a question. */
  question: string;
  /** Primary first. Two by default; a third only when the agent offered one. Never `Not now` or `skip`. */
  options: DecisionOption[];
  /** An approval's diff, linked from the summary. */
  diffHref: string | null;
  answer: DecisionAnswer;
  /** The keyboard shortcut applies to the primary: never on an approval that changes data on deploy. */
  shortcut: boolean;
}

/** At most this many options on a card: the primary, an alternative, and one genuinely different third. */
export const DECISION_OPTIONS_MAX = 3;

/** Past this many characters an effect folds into a tip and the button keeps its first clause. */
export const EFFECT_MAX = 72;

/** `Not now` and `skip` are never options: the card offers them as text buttons itself. */
const NOT_AN_OPTION = /^\s*(?:not now|skip(?: it| this)?|later|defer|decide later|ask me later)\s*[.!]?\s*$/i;

/** Prompts that name no decision (the write side, task 0dc386ae, steers agents away from these). */
const GENERIC_PROMPT = /^\s*(?:how (?:should|do) (?:i|we) proceed|what (?:should|do) (?:i|we) do(?: next)?|(?:any )?thoughts|please advise|what next)\s*\??\s*$/i;

export const isGenericPrompt = (prompt: string): boolean => GENERIC_PROMPT.test(prompt);

/** The first clause of a line: up to its first `.`, `;` or ` · `, within `max`. */
function firstClause(text: string, max = EFFECT_MAX): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.search(/[.;]\s|\s·\s/);
  const head = cut > 0 && cut <= max ? t.slice(0, cut) : t.slice(0, max);
  return `${head.replace(/[\s,;:]+$/, '')}…`;
}

/** An option's visible effect and its hover tip from one description line. */
export function splitEffect(description: string | null | undefined): { effect: string | null; tip: string | null } {
  const d = description?.replace(/\s+/g, ' ').trim();
  if (!d) return { effect: null, tip: null };
  if (d.length <= EFFECT_MAX) return { effect: d, tip: null };
  return { effect: firstClause(d), tip: d };
}

/** The question's options in card order: the recommended one first, never a skip, at most three. */
export function decisionOptions(options: readonly UnifiedQuestion['options'][number][], waits: QuestionWaits | null = null): DecisionOption[] {
  const kept = options.filter(o => !NOT_AN_OPTION.test(o.label));
  const ordered = [...kept].sort((a, b) => Number(b.recommended) - Number(a.recommended));
  return ordered.slice(0, DECISION_OPTIONS_MAX).map(o => ({ label: o.label, ...splitEffect(o.description), recommended: o.recommended, downstream: effectFor(waits, o.label) }));
}

/**
 * A lone option with no effect is a legacy note's `defaultChoice`, not a
 * choice (R-16 wants a primary and an alternative, each with an effect):
 * the card asks the question with Answer differently instead of drawing it
 * as one dark bar holding a sentence.
 */
function structuredOptions(options: DecisionOption[]): DecisionOption[] {
  return options.length === 1 && !options[0].effect ? [] : options;
}

const endsSentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/**
 * A question (a parked worker's, or an organizer's note) as the card: the
 * brief's context is the why, the projection's `waits` the what-waits and
 * each option's effect, the headline the question. A generic prompt is kept
 * as the question (the card already names the task above it); the write side
 * steers agents to name the decision.
 */
export function decisionFromQuestion(input: {
  key: string;
  question: UnifiedQuestion;
  task: DecisionView['task'];
  mission?: DecisionView['mission'];
  askedAt: number | null;
  waits?: QuestionWaits | null;
  /** Names of the tasks that wait on this decision, named in the summary. */
  dependents?: readonly string[];
  answer: DecisionAnswer;
}): DecisionView {
  const q = input.question;
  const why = (q.context ?? q.body ?? '').replace(/\s+/g, ' ').trim();
  const waits = input.waits ?? null;
  const names = (input.dependents ?? []).map(n => n.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const waiting = names.length
    ? `${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`} ${names.length === 1 ? 'waits' : 'wait'} on this.`
    : '';
  const summary = [why ? endsSentence(why) : '', waiting].filter(Boolean).join(' ');
  return {
    key: input.key,
    kind: 'decision',
    task: input.task,
    mission: input.mission ?? null,
    askedAt: input.askedAt,
    summary: summary || null,
    waits,
    question: q.headline.trim(),
    options: structuredOptions(decisionOptions(q.options, waits)),
    diffHref: null,
    answer: input.answer,
    shortcut: true,
  };
}

/**
 * An approval (a delivery whose next move is a person's: a merge under the
 * human tier, a gated migration): Approve and Request changes, the diff
 * linked from the summary, and no keyboard shortcut.
 */
export function approvalView(input: {
  key: string;
  task: DecisionView['task'];
  askedAt: number | null;
  /** The delivery's own sentence for why a person is needed. */
  reason: string | null;
  /** What waits on the approval, from the projection. */
  waits?: QuestionWaits | null;
  diffHref: string | null;
  /** Where Approve and Request changes go (the PR, its review). */
  approveHref: string;
  changesHref: string;
  /** The approval's effect lines; defaults fit a PR merge. */
  effects?: { approve: string; changes: string };
}): DecisionView {
  const why = input.reason?.replace(/\s+/g, ' ').trim();
  const effects = input.effects ?? { approve: 'Merges when green', changes: 'Builder revises it' };
  return {
    key: input.key,
    kind: 'approval',
    task: input.task,
    mission: null,
    askedAt: input.askedAt,
    summary: why ? endsSentence(why) : null,
    waits: input.waits ?? null,
    question: input.task ? `Approve ${input.task.title}?` : 'Approve the change?',
    options: [
      { label: 'Approve', effect: effects.approve, tip: null, recommended: false, downstream: null },
      { label: 'Request changes', effect: effects.changes, tip: null, recommended: false, downstream: null },
    ],
    diffHref: input.diffHref,
    answer: { kind: 'link', primaryHref: input.approveHref, secondaryHref: input.changesHref },
    shortcut: false,
  };
}

/** `asked 4m ago`; `asked just now` under a minute; null when the time is unknown. */
export function askedAgo(askedAt: number | null, now: number): string | null {
  if (askedAt == null) return null;
  const ms = Math.max(0, now - askedAt);
  if (ms < 60_000) return 'asked just now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `asked ${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `asked ${h}h ago`;
  return `asked ${Math.floor(h / 24)}d ago`;
}
