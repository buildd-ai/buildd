/**
 * Question gate: the decision definitions. Server-only.
 *
 * The questions the decision model is asked, their `defineDecision` calls, the
 * state it reads and the readers that turn a run into an answer. The runner
 * never imports this module (enforced by
 * apps/runner/__tests__/unit/no-decision-definitions-in-runner.test.ts); it
 * gets the wire contract from ./question-gate.ts instead.
 */
import { choice, defineDecision, type DecisionRun } from '@builddai/ai-kit/decide';
import type { BriefedQuestion } from './question-brief';
import {
  DEFAULT_QUESTION_GATE_MIN_CONFIDENCE,
  QUESTION_DECIDE_DECISION_TIMEOUT_MS,
  QUESTION_DECIDE_PROMPT_VERSION,
  QUESTION_GATE_DECISION_TIMEOUT_MS,
  QUESTION_GATE_PROMPT_VERSION,
  type QuestionDecideAnswer,
  type QuestionDisposition,
  type QuestionGateLabel,
} from './question-gate';

// ── Stage 1: the brief check ─────────────────────────────────────────────────

export const QUESTION_GATE_QUESTIONS = {
  verdict: choice(
    {
      question: 'An AI agent working on a software task wants to stop and ask a person the question below. The person has not seen the task, the code or the conversation, and reads it on a phone. Could they choose an answer in a few seconds from what is written here alone?',
      rule: 'Judge only what is written in `question`. Fields that are null were not given. Follow the definitions; when your impression and a definition conflict, the definition wins.',
    },
    {
      actionable: 'A reader with no other context could decide: it says what is being decided and where (the task or the part of the product), and the options say, or plainly imply, what each one leads to. A recommended default helps but is not required. Not for a question that names code, variables or settings without saying what they are for or what changes.',
      needs_context: 'A reader with no context could not decide: the question assumes knowledge of the task or the code, names identifiers or choices without saying what they affect, or the options are bare labels whose consequences are unclear. Example: "Should isWeekend use local time or UTC?" with options "local time" and "UTC". Not for a question whose framing and options already say what is decided and what each choice changes.',
    },
  ),
};

export const QUESTION_GATE_DECISION = defineDecision({
  id: 'buildd.question_gate',
  promptVersion: QUESTION_GATE_PROMPT_VERSION,
  questions: QUESTION_GATE_QUESTIONS,
  mode: 'gated',
  minConfidence: DEFAULT_QUESTION_GATE_MIN_CONFIDENCE,
  timeoutMs: QUESTION_GATE_DECISION_TIMEOUT_MS,
});

/** The record the model reads: the question as the person would see it, plus the task title. */
export function buildQuestionGateState(q: BriefedQuestion, taskTitle: string | null): Record<string, unknown> {
  const options = (q.options ?? []).map(o => typeof o === 'string'
    ? { label: o, leadsTo: null }
    : { label: o.label, leadsTo: o.consequence ?? o.description ?? null });
  return {
    question: {
      task: taskTitle ?? q.where?.taskTitle ?? null,
      context: q.context ?? null,
      asks: q.prompt,
      options,
      recommended: q.recommended ? { option: q.recommended.label, why: q.recommended.reason ?? null } : null,
    },
  };
}

/** The label and confidence of a run, whatever the definition's own gate said; null on failure. */
export function readQuestionGateRun(run: DecisionRun<typeof QUESTION_GATE_QUESTIONS>): { label: QuestionGateLabel; confidence: number } | null | { error: string } {
  const outcome = run.outcomes.verdict;
  if (!run.ok || !outcome || outcome.status === 'skipped') {
    return { error: !run.result.ok ? run.result.error.kind : 'no_answer' };
  }
  return { label: outcome.value as QuestionGateLabel, confidence: outcome.confidence };
}

// ── Stage 2: decide / hold / ask ─────────────────────────────────────────────

/** How many of `question.options` the decide call can address by index. */
export const OPTION_SLOTS = 12;
type OptionSlotLabel = `opt${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11}`;
const OPTION_SLOT_LABELS: readonly OptionSlotLabel[] = [
  'opt0', 'opt1', 'opt2', 'opt3', 'opt4', 'opt5', 'opt6', 'opt7', 'opt8', 'opt9', 'opt10', 'opt11',
];

const DECIDE_DISPOSITION_INSTRUCTIONS = {
  question: 'An AI agent asked the question below and is waiting for an answer before it can continue. You are the team\'s standing decision-maker for exactly this kind of question. Should you pick an answer yourself, hold the question back for now, or send it to a person?',
  rule: 'Judge only what is written in `question`. Pick "decide" only when the options already say what each one leads to and getting it wrong would be minor and easy to correct later. Pick "ask" whenever getting it wrong would be hard to undo, or the choice genuinely needs a person\'s judgment the question does not supply. Pick "hold" when the question is real but there is no reason it needs an answer right this moment.',
};

const DECIDE_OPTION_INDEX_INSTRUCTIONS = {
  question: 'If you picked "decide" above, which listed option should the agent take? Count `question.options` from the top, starting at 0 (the first option is opt0, the second is opt1, and so on). Ignored unless disposition is "decide".',
  rule: 'Choose only an index that corresponds to an option actually present in `question.options`. Never invent an option that is not listed.',
};

function optionSlotCriteria(): Record<OptionSlotLabel, string> {
  const ordinal = (n: number) => `${n + 1}${['th', 'st', 'nd', 'rd'][n % 10 > 3 || [11, 12, 13].includes((n + 1) % 100) ? 0 : (n + 1) % 10]}`;
  return Object.fromEntries(OPTION_SLOT_LABELS.map((label, i) => [label, `The ${ordinal(i)} listed option.`])) as Record<OptionSlotLabel, string>;
}

export const QUESTION_DECIDE_QUESTIONS = {
  disposition: choice(DECIDE_DISPOSITION_INSTRUCTIONS, {
    decide: 'Pick one of the listed options yourself. The agent continues immediately with that choice; nobody is parked or notified.',
    hold: 'The question is real but can wait. Park it without interrupting anyone right now; a person sees it when they next check in.',
    ask: 'Send this to a person now, with the full brief, because the choice is not yours to make.',
  }),
  optionIndex: choice(DECIDE_OPTION_INDEX_INSTRUCTIONS, optionSlotCriteria()),
};

export const QUESTION_DECIDE_DECISION = defineDecision({
  id: 'buildd.question_decide',
  promptVersion: QUESTION_DECIDE_PROMPT_VERSION,
  questions: QUESTION_DECIDE_QUESTIONS,
  mode: 'live',
  timeoutMs: QUESTION_DECIDE_DECISION_TIMEOUT_MS,
});

/** The disposition (and, when decided, the option index) a run answered; null fields on failure. */
export function readQuestionDecideRun(run: DecisionRun<typeof QUESTION_DECIDE_QUESTIONS>): QuestionDecideAnswer | { error: string } {
  const d = run.outcomes.disposition;
  if (!run.ok || !d || d.status === 'skipped') {
    return { error: !run.result.ok ? run.result.error.kind : 'no_answer' };
  }
  const o = run.outcomes.optionIndex;
  const optionIndex = o && o.status !== 'skipped' ? OPTION_SLOT_LABELS.indexOf(o.value as OptionSlotLabel) : -1;
  return {
    disposition: d.value as QuestionDisposition,
    dispositionConfidence: d.confidence,
    optionIndex: optionIndex >= 0 ? optionIndex : null,
    optionIndexConfidence: o && o.status !== 'skipped' ? o.confidence : null,
  };
}
