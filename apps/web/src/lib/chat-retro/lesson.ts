/**
 * The retro's decision questions, their gates, and the code that turns the
 * model's labels back into a content-free lesson row.
 *
 * The crux (knowledge-base: buildd/design/chat-session-retro.md): the model labels, code counts,
 * and nothing in the loop writes prose. Every number on a lesson comes from
 * ./skeleton.ts; the model only picks labels from ./vocab.ts.
 */
import { createHash } from 'node:crypto';
import type { ChoiceAnswer, ChoiceQuestion } from '@buildd/core/decision-client';
import { renderTemplate, resolvePromptValue } from '@buildd/core/prompts';
import type { Candidate, WindowTotals } from './skeleton';
import {
  CANDIDATE_KINDS, CAUSE_LABELS, CHAT_RETRO_VERSION, EVIDENCE_KEYS, LESSON_TEXT_COLUMNS,
  type CauseLabel, type FixClassLabel, type IntentLabel, type RetroStatus,
  type SatisfiedLabel, type SkipReason, type TurnLabel,
} from './vocab';
import { registerValuePrompt } from '@buildd/core/prompts';

export const GATES = { satisfied: 0.8, intent: 0.7, turn: 0.8, fixClass: 0.7 } as const;

/** `ai_usage.kind` of a retro's decision receipt (surface `decision`). */
export const CHAT_RETRO_DECISION_ID = 'chat_retro';

const SATISFIED_Q: ChoiceQuestion<SatisfiedLabel> = {
  type: 'choice',
  instructions: {
    question: 'Did the person get what they came for in this chat session?',
    rule: 'Judge from the user turns, the flags and how the session ended. A thumbs-down on a turn counts against it.',
  },
  criteria: {
    yes: { what: 'They got the answer or action they asked for and moved on.', not_for: 'Sessions that ended on a stopped turn, a restated question or a thumbs-down.' },
    partly: { what: 'Some of what they asked for, after a detour, a retry or a narrower follow-up.', not_for: 'A clean answer, or a session that never got there.' },
    no: { what: 'They did not get it: the session ended stopped, denied, re-asked or abandoned.', not_for: 'A session that recovered on a later turn.' },
  },
};

const INTENT_Q: ChoiceQuestion<IntentLabel> = {
  type: 'choice',
  instructions: { question: 'What was the person mainly after in this session?', rule: 'Pick the goal of the session as a whole, from the user turns.' },
  criteria: {
    status_check: { what: 'What is stuck, running, failing or done right now.', not_for: 'Finding one named object.' },
    find_object: { what: 'Locating a specific task, PR, mission, artifact or setting.', not_for: 'A general status question.' },
    explain: { what: 'Understanding why something happened or how something works.', not_for: 'Asking for a change.' },
    act: { what: 'Making a change: file, retry, cancel, merge, update.', not_for: 'Planning work without doing it.' },
    plan: { what: 'Deciding what to do next or breaking work down.', not_for: 'Carrying out a single change.' },
    configure: { what: 'Changing settings, roles, schedules, keys or integrations.', not_for: 'Changing a task or mission.' },
  },
};

const TURN_CRITERIA: Record<TurnLabel, { what: string; not_for: string }> = {
  needed: { what: 'This flagged turn was a reasonable step toward the goal.', not_for: 'A turn that fetched, retried or stopped for nothing.' },
  wrong_tool: { what: 'An existing tool was used where a different existing tool fit.', not_for: 'No tool could have answered narrowly.' },
  missing_capability: { what: 'No tool or parameter could answer narrowly, so the model fetched broadly or gave up.', not_for: 'A better tool existed.' },
  misleading_description: { what: 'The model used the tool its description pointed to, and that was the wrong one.', not_for: 'A plain wrong choice between clearly described tools.' },
  over_fetch: { what: 'The result was far larger than what the answer used.', not_for: 'A large result the answer needed.' },
  reasoning_timeout: { what: 'The turn ran out of time before answering.', not_for: 'A turn that answered.' },
  re_asked: { what: 'The next user turn restates the previous question because it was not answered.', not_for: 'A genuinely new follow-up.' },
  wrong_tier: { what: 'The routed tier was too weak or too strong for the turn.', not_for: 'A tool or description problem.' },
};

const FIX_CLASS_Q: ChoiceQuestion<FixClassLabel> = {
  type: 'choice',
  instructions: { question: 'Which kind of change to buildd would most have prevented the waste in this session?', rule: 'Pick one class; the details are worked out later by a person.' },
  criteria: {
    tool_description: { what: 'Rewording a tool description so the model picks or uses it correctly.', not_for: 'A tool or parameter that does not exist.' },
    tool_or_param: { what: 'A missing tool or a missing parameter (filter, limit, field).', not_for: 'Rewording an existing tool.' },
    system_prompt: { what: 'An instruction in the agent\'s own system prompt.', not_for: 'Anything specific to one tool.' },
    routing_tier: { what: 'Routing the turn to a different tier.', not_for: 'Tool choice.' },
    directive_or_memory: { what: 'A standing rule or memory for this person or team.', not_for: 'A change to buildd itself.' },
    ui: { what: 'Something on the screen that would have made the question unnecessary.', not_for: 'Anything in the model\'s behaviour.' },
  },
};

export type RetroQuestions = Record<string, ChoiceQuestion<string>>;

/**
 * The retro's question text, resolved through the versioned prompts table
 * (`@buildd/core/prompts`): an active row's body is JSON of exactly this shape
 * (same labels, the turn question keeping its placeholders), else this public
 * default runs.
 */
export const CHAT_RETRO_PROMPT_ID = 'buildd.chat_retro.questions';

export const CHAT_RETRO_PROMPT_DEFAULT = {
  satisfied: SATISFIED_Q,
  intent: INTENT_Q,
  turnQuestion: 'Was flagged candidate turn_{{id}} ({{kind}} at turn #{{turn}}) needed, or wasted, and why?',
  turnCriteria: TURN_CRITERIA,
  fixClass: FIX_CLASS_Q,
};

/** The questions for one window. `stopped` candidates are labelled by code and not asked. */
export function buildQuestions(candidates: Candidate[]): RetroQuestions {
  const text = resolvePromptValue(CHAT_RETRO_PROMPT_ID, CHAT_RETRO_PROMPT_DEFAULT);
  const q: RetroQuestions = { satisfied: text.satisfied, intent: text.intent };
  for (const c of candidates) {
    if (c.kind === 'stopped') continue;
    q[`turn_${c.id}`] = {
      type: 'choice',
      instructions: { question: renderTemplate(text.turnQuestion, { id: c.id, kind: c.kind, turn: c.turn }) },
      criteria: text.turnCriteria,
    };
  }
  if (candidates.length > 0) q.fix_class = text.fixClass;
  return q;
}

type Answers = Record<string, ChoiceAnswer<string> | undefined>;

export interface EvidenceEntry {
  turn: number;
  messageId: string;
  kind: string;
  tokens: number;
  label: string | null;
  conf: number | null;
}

/** A lesson row, before ids and timestamps the store adds. */
export interface LessonRow {
  teamId: string;
  conversationId: string;
  workspaceId: string | null;
  fromMessageId: string | null;
  toMessageId: string | null;
  toMessageAt: Date;
  status: RetroStatus;
  skipReason: SkipReason | null;
  userTurns: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  intent: IntentLabel | null;
  intentConf: number | null;
  satisfied: SatisfiedLabel | null;
  satisfiedConf: number | null;
  wastedTurns: number;
  wastedTokens: number;
  primaryCause: CauseLabel | null;
  fixClass: FixClassLabel | null;
  fixClassConf: number | null;
  toolName: string | null;
  signature: string | null;
  evidence: EvidenceEntry[];
  stateTokens: number | null;
  version: string;
  latencyMs: number | null;
  jevCostUsd: number | null;
  error: string | null;
}

export interface WindowRef {
  teamId: string;
  conversationId: string;
  workspaceId: string | null;
  fromMessageId: string | null;
  toMessageId: string | null;
  toMessageAt: Date;
}

const gated = (a: ChoiceAnswer<string> | undefined, min: number): { label: string; conf: number } | null =>
  a && a.confidence >= min ? { label: a.choice, conf: a.confidence } : null;

export function retroSignature(cause: CauseLabel, fix: FixClassLabel, tool: string | null): string {
  const t = tool ?? 'none';
  const hash = createHash('sha256').update(`${cause}|${fix}|${t}`).digest('hex').slice(0, 6);
  return `chat-retro:${cause}-${fix}-${t}-${hash}`;
}

function emptyLesson(ref: WindowRef, totals: WindowTotals, version: string): LessonRow {
  return {
    ...ref,
    status: 'skipped', skipReason: null,
    userTurns: totals.userTurns, turns: totals.turns,
    inputTokens: totals.inputTokens, outputTokens: totals.outputTokens,
    costUsd: totals.costUsd,
    intent: null, intentConf: null, satisfied: null, satisfiedConf: null,
    wastedTurns: 0, wastedTokens: 0,
    primaryCause: null, fixClass: null, fixClassConf: null, toolName: null, signature: null,
    evidence: [], stateTokens: null, version, latencyMs: null, jevCostUsd: null, error: null,
  };
}

export function skippedLesson(ref: WindowRef, totals: WindowTotals, reason: SkipReason, stateTokens: number | null = null): LessonRow {
  return { ...emptyLesson(ref, totals, CHAT_RETRO_VERSION), skipReason: reason, stateTokens };
}

export function failedLesson(ref: WindowRef, totals: WindowTotals, errorKind: string, stateTokens: number, latencyMs: number | null): LessonRow {
  return { ...emptyLesson(ref, totals, CHAT_RETRO_VERSION), status: 'failed', error: errorKind, stateTokens, latencyMs };
}

/**
 * Turn the model's answers into a lesson. Code does every sum: a candidate
 * counts as waste only when its label clears the turn gate and is not
 * `needed`; `stopped` candidates are `reasoning_timeout` by code.
 */
export function judgedLesson(args: {
  ref: WindowRef;
  totals: WindowTotals;
  candidates: Candidate[];
  answers: Answers;
  model: string;
  stateTokens: number;
  latencyMs: number;
  jevCostUsd: number | null;
}): LessonRow {
  const { candidates, answers } = args;
  const row = emptyLesson(args.ref, args.totals, `${CHAT_RETRO_VERSION}|${args.model}`);
  row.status = 'judged';
  row.stateTokens = args.stateTokens;
  row.latencyMs = args.latencyMs;
  row.jevCostUsd = args.jevCostUsd;

  const satisfied = gated(answers.satisfied, GATES.satisfied);
  if (satisfied) { row.satisfied = satisfied.label as SatisfiedLabel; row.satisfiedConf = satisfied.conf; }
  const intent = gated(answers.intent, GATES.intent);
  if (intent) { row.intent = intent.label as IntentLabel; row.intentConf = intent.conf; }

  const byCause = new Map<CauseLabel, { tokens: number; codeDetected: boolean; tools: Map<string, number> }>();
  const wasteTurns = new Set<number>();
  const counted = new Set<string>();
  for (const c of candidates) {
    const coded = c.kind === 'stopped';
    const a = coded ? { label: 'reasoning_timeout', conf: 1 } : gated(answers[`turn_${c.id}`], GATES.turn);
    const raw = answers[`turn_${c.id}`];
    row.evidence.push({
      turn: c.turn, messageId: c.messageId, kind: c.kind, tokens: c.tokens,
      label: coded ? 'reasoning_timeout' : raw?.choice ?? null,
      conf: coded ? 1 : raw?.confidence ?? null,
    });
    if (!a || a.label === 'needed' || !(CAUSE_LABELS as readonly string[]).includes(a.label)) continue;
    const cause = a.label as CauseLabel;
    wasteTurns.add(c.turn);
    // A turn's tokens count once, however many of its candidates were waste.
    const key = c.kind === 'large_result' || c.kind === 'repeat_call' ? `${c.turn}:${c.kind}:${c.toolName}` : `${c.turn}:turn`;
    const tokens = counted.has(key) ? 0 : c.tokens;
    counted.add(key);
    const entry = byCause.get(cause) ?? { tokens: 0, codeDetected: false, tools: new Map() };
    entry.tokens += tokens;
    entry.codeDetected ||= coded;
    if (c.toolName) entry.tools.set(c.toolName, (entry.tools.get(c.toolName) ?? 0) + Math.max(tokens, 1));
    byCause.set(cause, entry);
  }
  row.wastedTurns = wasteTurns.size;
  row.wastedTokens = [...byCause.values()].reduce((s, e) => s + e.tokens, 0);

  if (byCause.size > 0) {
    // Most wasted tokens wins; a tie goes to the cause code detected, then vocabulary order.
    const [cause, entry] = [...byCause.entries()].sort((a, b) =>
      b[1].tokens - a[1].tokens
      || Number(b[1].codeDetected) - Number(a[1].codeDetected)
      || CAUSE_LABELS.indexOf(a[0]) - CAUSE_LABELS.indexOf(b[0]))[0];
    row.primaryCause = cause;
    row.toolName = [...entry.tools.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
    const fix = gated(answers.fix_class, GATES.fixClass);
    if (fix) {
      row.fixClass = fix.label as FixClassLabel;
      row.fixClassConf = fix.conf;
      row.signature = retroSignature(cause, row.fixClass, row.toolName);
    }
  }
  return row;
}

const TEXT_FIELDS: Record<string, keyof LessonRow> = {
  status: 'status', skip_reason: 'skipReason', intent: 'intent', satisfied: 'satisfied',
  primary_cause: 'primaryCause', fix_class: 'fixClass', tool_name: 'toolName',
  signature: 'signature', version: 'version', error: 'error',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Throws when a row carries a text value outside its vocabulary, or evidence
 * with anything but refs, numbers and labels. Called on every row before it
 * is written, so a bug cannot put message text into the table.
 */
export function assertContentFree(row: LessonRow): void {
  for (const [column, field] of Object.entries(TEXT_FIELDS)) {
    const v = row[field];
    if (v === null || v === undefined) continue;
    const allowed = LESSON_TEXT_COLUMNS[column];
    const ok = typeof v === 'string' && (allowed instanceof RegExp ? allowed.test(v) : allowed.includes(v));
    if (!ok) throw new Error(`chat_retros.${column}: value outside its vocabulary`);
  }
  for (const e of row.evidence) {
    const keys = Object.keys(e);
    if (keys.some(k => !(EVIDENCE_KEYS as readonly string[]).includes(k))) throw new Error('chat_retros.evidence: unexpected key');
    if (!UUID_RE.test(e.messageId)) throw new Error('chat_retros.evidence: messageId is not a ref');
    if (!Number.isInteger(e.turn) || typeof e.tokens !== 'number') throw new Error('chat_retros.evidence: non-numeric count');
    if (!(CANDIDATE_KINDS as readonly string[]).includes(e.kind)) throw new Error('chat_retros.evidence: kind outside its vocabulary');
    if (e.label !== null && e.label !== 'needed' && !(CAUSE_LABELS as readonly string[]).includes(e.label)) throw new Error('chat_retros.evidence: label outside its vocabulary');
    if (e.conf !== null && typeof e.conf !== 'number') throw new Error('chat_retros.evidence: non-numeric confidence');
  }
}

// Registered for the deploy seed and the fallback alert (`@buildd/core/prompts`).
registerValuePrompt(CHAT_RETRO_PROMPT_ID, CHAT_RETRO_PROMPT_DEFAULT);
