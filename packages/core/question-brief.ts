/**
 * Question brief: the pure half. The gate that reviews a brief is in ./question-gate.ts.
 *
 * When an agent stops to ask a person something (AskUserQuestion, surfaced as
 * a worker in `waiting_input`), the person often has no idea which task it is,
 * what the code is, or what each answer leads to. The brief is the few lines
 * that fix that:
 *
 * - `context`: at most two sentences, the task and the exact decision.
 * - per-option `consequence`: one line, what picking it leads to.
 * - `recommended`: the agent's default and why.
 * - `where`: facts the runner already has (task title, branch, last file).
 *
 * AskUserQuestion's input schema belongs to the SDK, so the agent cannot add
 * fields to it. The runner derives the brief deterministically from what the
 * tool call does carry: leading statements before the final question are the
 * context, each option's `description` is its consequence, and an option
 * labelled "… (Recommended)" (Claude Code's own convention) is the default.
 *
 * Everything here is pure and safe to import from client components.
 */

export interface BriefOptionInput {
  label: string;
  description?: string;
}

export interface BriefOption {
  label: string;
  description?: string;
  consequence?: string;
  recommended?: boolean;
}

export interface BriefWhere {
  taskTitle?: string;
  branch?: string;
  file?: string;
}

export interface QuestionBriefFields {
  context?: string;
  recommended?: { label: string; reason?: string };
  where?: BriefWhere;
  /** Set only to `'hold'` — Jev held this question rather than asking outright. See question-gate.ts `HOLD_RESURFACE_MS`. */
  disposition?: 'hold';
  /** Why it was held, in the words a person reads on the parked question. */
  holdReason?: string;
  /** ISO timestamp. Not yet consulted by any notification path — see question-gate.ts `HOLD_RESURFACE_MS`. */
  resurfaceAt?: string;
}

export interface DerivedQuestion extends QuestionBriefFields {
  prompt: string;
  options: BriefOption[];
}

/** Caps, in characters. Short on purpose: the brief is read in seconds. */
export const BRIEF_CONTEXT_MAX = 320;
export const BRIEF_LINE_MAX = 200;
export const BRIEF_WHERE_MAX = 200;
export const BRIEF_CONTEXT_MAX_SENTENCES = 2;

/**
 * Steering for the agent, injected into the session's Communication section
 * wherever AskUserQuestion is allowed. The person answering has not seen the
 * task, the code or this conversation.
 */
export const QUESTION_BRIEF_GUIDANCE =
  'Every AskUserQuestion must be a self-contained decision brief: the person answering has not seen this task, the code or this conversation, and should be able to decide in seconds. ' +
  'In the question text, start with one or two plain sentences saying which task this is and exactly what is being decided and why it matters, then ask the question. ' +
  'Give every option a description saying what choosing it leads to, in one line. ' +
  'Put your recommended option first and end its label with "(Recommended)"; its description says why. ' +
  'Bad: "Should isWeekend use local time or UTC?" with bare options. ' +
  'Good: "Adding isWeekend() to the billing date helpers; it decides whether weekend surcharges apply. Should it use the customer\'s local time or UTC?" with options that each say who is charged differently.';

const RECOMMENDED_SUFFIX = /\s*[([]\s*recommended\s*[)\]]\s*$/i;

function clean(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Sentences, split on terminal punctuation followed by whitespace. */
function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'`(\[])/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** At most `BRIEF_CONTEXT_MAX_SENTENCES` sentences, capped in length. */
export function clampContext(text: unknown): string | undefined {
  const t = clean(text, 10_000);
  if (!t) return undefined;
  return clean(sentences(t).slice(0, BRIEF_CONTEXT_MAX_SENTENCES).join(' '), BRIEF_CONTEXT_MAX);
}

/**
 * Split question text into its framing and the question itself. Only when the
 * text ends with a question and has statements before it; otherwise the whole
 * text stays the prompt and there is no derived context.
 */
export function splitQuestionText(text: string): { prompt: string; context?: string } {
  const parts = sentences(text);
  if (parts.length < 2) return { prompt: text.trim() };
  const last = parts[parts.length - 1];
  if (!last.endsWith('?')) return { prompt: text.trim() };
  // The question may itself span sentences ("Local or UTC? Or both?").
  let firstQuestion = parts.length - 1;
  while (firstQuestion > 0 && parts[firstQuestion - 1].endsWith('?')) firstQuestion--;
  if (firstQuestion === 0) return { prompt: text.trim() };
  const context = clampContext(parts.slice(0, firstQuestion).join(' '));
  return { prompt: parts.slice(firstQuestion).join(' '), ...(context ? { context } : {}) };
}

/**
 * The brief for one AskUserQuestion question, from the tool input and the
 * runner's own facts. Never invents text: what the agent did not write stays
 * absent.
 */
export function deriveQuestionBrief(
  question: { question: string; options?: BriefOptionInput[] | null },
  facts: BriefWhere = {},
): DerivedQuestion {
  const { prompt, context } = splitQuestionText(question.question);
  let recommended: DerivedQuestion['recommended'];
  const options: BriefOption[] = [];
  for (const o of question.options ?? []) {
    if (!o || typeof o.label !== 'string' || !o.label.trim()) continue;
    const isRecommended = RECOMMENDED_SUFFIX.test(o.label);
    const label = o.label.replace(RECOMMENDED_SUFFIX, '').trim() || o.label.trim();
    const consequence = clean(o.description, BRIEF_LINE_MAX);
    const opt: BriefOption = {
      label,
      ...(o.description ? { description: o.description } : {}),
      ...(consequence ? { consequence } : {}),
      ...(isRecommended ? { recommended: true } : {}),
    };
    if (isRecommended && !recommended) recommended = { label, ...(consequence ? { reason: consequence } : {}) };
    options.push(opt);
  }
  const where = sanitizeWhere(facts);
  return {
    prompt,
    options,
    ...(context ? { context } : {}),
    ...(recommended ? { recommended } : {}),
    ...(where ? { where } : {}),
  };
}

function sanitizeWhere(raw: unknown): BriefWhere | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const where: BriefWhere = {};
  const taskTitle = clean(r.taskTitle, BRIEF_WHERE_MAX);
  const branch = clean(r.branch, BRIEF_WHERE_MAX);
  const file = clean(r.file, BRIEF_WHERE_MAX);
  if (taskTitle) where.taskTitle = taskTitle;
  if (branch) where.branch = branch;
  if (file) where.file = file;
  return Object.keys(where).length ? where : undefined;
}

/**
 * Server-side validation of the brief fields on a `waitingFor` payload. Drops
 * anything malformed rather than refusing the PATCH (an old or buggy runner
 * must still park its question), and caps every field.
 */
export function sanitizeQuestionBrief(raw: unknown): QuestionBriefFields & { options?: unknown[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: QuestionBriefFields & { options?: unknown[] } = {};
  const context = clampContext(r.context);
  if (context) out.context = context;
  const rec = r.recommended;
  if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
    const label = clean((rec as Record<string, unknown>).label, BRIEF_LINE_MAX);
    const reason = clean((rec as Record<string, unknown>).reason, BRIEF_LINE_MAX);
    if (label) out.recommended = { label, ...(reason ? { reason } : {}) };
  }
  const where = sanitizeWhere(r.where);
  if (where) out.where = where;
  if (r.disposition === 'hold') {
    out.disposition = 'hold';
    const holdReason = clean(r.holdReason, BRIEF_LINE_MAX);
    if (holdReason) out.holdReason = holdReason;
    const resurfaceAt = typeof r.resurfaceAt === 'string' && !Number.isNaN(Date.parse(r.resurfaceAt)) ? r.resurfaceAt : undefined;
    if (resurfaceAt) out.resurfaceAt = resurfaceAt;
  }
  if (Array.isArray(r.options)) {
    out.options = r.options.map(o => {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
      const { consequence, ...rest } = o as Record<string, unknown>;
      const c = clean(consequence, BRIEF_LINE_MAX);
      return c ? { ...rest, consequence: c } : rest;
    });
  }
  return out;
}

/**
 * A `waitingFor` with its brief fields replaced by their sanitized form:
 * malformed `context` / `recommended` / `where` / option `consequence` are
 * dropped, everything else is kept as sent.
 */
export function withSanitizedBrief<T extends Record<string, unknown>>(waitingFor: T): T {
  const { context: _c, recommended: _r, where: _w, ...rest } = waitingFor as Record<string, unknown>;
  return { ...rest, ...sanitizeQuestionBrief(waitingFor) } as T;
}

/** A question as the gate and the notification read it. */
export interface BriefedQuestion extends QuestionBriefFields {
  prompt: string;
  options?: Array<string | { label: string; description?: string; consequence?: string; recommended?: boolean }>;
}

/** Every bit of visible text in a question, for a hard-rail text check (question-gate.ts `detectHardRail`). */
export function briefedQuestionText(q: BriefedQuestion): string {
  const parts: string[] = [q.prompt];
  if (q.context) parts.push(q.context);
  for (const o of q.options ?? []) {
    if (typeof o === 'string') { parts.push(o); continue; }
    parts.push(o.label);
    if (o.consequence) parts.push(o.consequence);
    if (o.description) parts.push(o.description);
  }
  if (q.recommended) {
    parts.push(q.recommended.label);
    if (q.recommended.reason) parts.push(q.recommended.reason);
  }
  return parts.join(' ');
}

function optionLabel(o: string | { label: string }): string {
  return typeof o === 'string' ? o : o.label;
}

/** The recommended option, from `recommended` or an option flagged as such. */
export function recommendedOf(q: BriefedQuestion): { label: string; reason?: string } | undefined {
  if (q.recommended?.label) return q.recommended;
  for (const o of q.options ?? []) {
    if (typeof o !== 'string' && o.recommended) {
      const reason = o.consequence ?? o.description;
      return { label: o.label, ...(reason ? { reason } : {}) };
    }
  }
  return undefined;
}

/**
 * What a brief is missing, in the words the pushback uses. Empty when every
 * part is present (the gate can still judge the wording too thin).
 */
export function missingBriefParts(q: BriefedQuestion): string[] {
  const missing: string[] = [];
  if (!q.context) missing.push('which task this is and exactly what is being decided, and why it matters (one or two sentences before the question)');
  const opts = q.options ?? [];
  if (opts.length > 0 && opts.some(o => typeof o === 'string' || !(o.consequence ?? o.description))) {
    missing.push('a one-line description on every option saying what choosing it leads to');
  }
  if (!recommendedOf(q)) missing.push('your recommended default, first, with "(Recommended)" at the end of its label and why in its description');
  return missing;
}

/**
 * The text the agent gets back instead of a parked question, when Jev decided
 * the question itself (question-gate.ts `QuestionGateReply.verdict === 'decide'`).
 * Shaped like a person's answer, not a system message, because the agent
 * should treat it exactly as it would treat a human reply to the same
 * AskUserQuestion call.
 */
export function questionDecideAnswerText(q: BriefedQuestion, optionIndex: number): string {
  const opts = q.options ?? [];
  const chosen = opts[optionIndex];
  const label = chosen ? optionLabel(chosen) : 'the recommended option';
  const detail = chosen && typeof chosen !== 'string' ? (chosen.consequence ?? chosen.description) : undefined;
  return `${label}.${detail ? ` ${detail}` : ''} (Decided automatically and recorded on the task — can be corrected from the task page if it turns out wrong.)`;
}

/** The text the agent gets back instead of a parked question. */
export function questionPushbackText(q: BriefedQuestion): string {
  const missing = missingBriefParts(q);
  const add = missing.length
    ? `Add: ${missing.join('; ')}.`
    : 'It still assumes context the reader does not have: name the task and the code involved in plain words, say what each option changes, and why you recommend one.';
  return `Not sent: a reader with no context could not decide this question. ${add} Then ask again.`;
}

function firstSentence(text: string, max: number): string {
  return clean(sentences(text)[0] ?? text, max) ?? '';
}

/**
 * Push / Pushover text for a parked question: short by design. Title, the
 * question, one line of context, and the recommended default. A sensitive
 * workspace gets the generic line only.
 */
export function questionNotificationText(
  q: BriefedQuestion | null | undefined,
  opts: { sensitive?: boolean } = {},
): { title: string; message: string } {
  const title = 'Agent needs input';
  if (opts.sensitive) return { title, message: 'Agent waiting for input' };
  const prompt = clean(q?.prompt, 160) ?? 'A task needs a response';
  const lines = [prompt];
  const context = q?.context
    ? firstSentence(q.context, 140)
    : q?.where?.taskTitle ? clean(`Task: ${q.where.taskTitle}`, 140) : undefined;
  if (context) lines.push(context);
  const rec = q ? recommendedOf(q) : undefined;
  if (rec) lines.push(clean(`Recommended: ${rec.label}${rec.reason ? `. ${rec.reason}` : ''}`, 140)!);
  return { title, message: lines.join('\n') };
}

/** For compact surfaces: "Recommended: X. Why". */
export function recommendedLine(q: BriefedQuestion): string | undefined {
  const rec = recommendedOf(q);
  return rec ? `Recommended: ${rec.label}${rec.reason ? `. ${rec.reason}` : ''}` : undefined;
}

/** The options as plain labels (gate state, compact surfaces). */
export function optionLabels(q: BriefedQuestion): string[] {
  return (q.options ?? []).map(optionLabel).filter(l => typeof l === 'string' && l.trim().length > 0);
}
