/**
 * One question, one surface. A worker's open question can arrive two ways —
 * `workers.waitingFor` (the SDK's AskUserQuestion) and a `mission_notes` row of
 * type `question` (the MCP post_note path) — and often both at once for the
 * same ask. These helpers fold them into a single shape the QuestionHero
 * renders: the note contributes the short headline, the explanation and its
 * `defaultChoice` (shown as the recommended option); `waitingFor` contributes
 * the options.
 */
import type { WaitingForOption } from '@buildd/core/db/schema';
import { fallbackQuestionContext } from '@buildd/core/human-attention';

export interface QuestionOption {
  label: string;
  description?: string;
  recommended: boolean;
}

export interface UnifiedQuestion {
  headline: string;
  body: string | null;
  options: QuestionOption[];
  /** The mission note this question is (also) recorded as, if any. */
  noteId: string | null;
  /**
   * Question brief (packages/core/question-brief.ts): the task and the exact
   * decision, in at most two sentences. Absent on questions without one.
   */
  context?: string;
  /** Where it was asked from: task title, branch, last edited file. */
  where?: { taskTitle?: string; branch?: string; file?: string };
}

type BriefedWaitingFor = {
  prompt: string;
  options?: WaitingForOption[] | null;
  type?: string;
  context?: string;
  recommended?: { label: string; reason?: string };
  where?: { taskTitle?: string; branch?: string; file?: string };
};

/** The brief fields worth carrying onto the unified question. */
function briefOf(w: BriefedWaitingFor): Pick<UnifiedQuestion, 'context' | 'where'> {
  const out: Pick<UnifiedQuestion, 'context' | 'where'> = {};
  if (typeof w.context === 'string' && w.context.trim()) out.context = w.context.trim();
  const where = w.where && typeof w.where === 'object' ? w.where : null;
  if (where && (where.taskTitle || where.branch || where.file)) out.where = where;
  return out;
}

/**
 * Mark the brief's recommended option and give it the reason when the option
 * has no line of its own. Labels match case-insensitively.
 */
function withRecommendation(options: QuestionOption[], rec: BriefedWaitingFor['recommended']): QuestionOption[] {
  if (!rec?.label || options.some(o => o.recommended)) return options;
  return options.map(o => same(o.label, rec.label)
    ? { ...o, recommended: true, ...(!o.description && rec.reason ? { description: rec.reason } : {}) }
    : o);
}

export interface QuestionNoteLike {
  id: string;
  workerId?: string | null;
  type: string;
  status: string;
  title: string;
  body?: string | null;
  defaultChoice?: string | null;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function normalizeOptions(options: WaitingForOption[] | null | undefined, defaultChoice?: string | null): QuestionOption[] {
  if (!Array.isArray(options)) return [];
  const out: QuestionOption[] = [];
  for (const o of options) {
    if (typeof o === 'string') {
      if (o.trim()) out.push({ label: o, recommended: false });
    } else if (o && typeof o === 'object' && typeof o.label === 'string' && o.label.trim()) {
      // The brief's one-line consequence is what the option leads to; the
      // agent's own description is the fallback (older questions).
      const description = o.consequence || o.description;
      out.push({
        label: o.label,
        ...(description ? { description } : {}),
        recommended: o.recommended === true,
      });
    }
  }
  if (defaultChoice && !out.some(o => o.recommended)) {
    for (const o of out) if (same(o.label, defaultChoice)) o.recommended = true;
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The agent's own words for what an option means, when its explanation names
 * the option: "…Per line: the total equals… Total only: matches…". Only the
 * option's lead phrase is matched (the label up to a dash or a colon: "Per
 * line — match Stripe", "Per line: match Stripe"), and only a phrase followed
 * by a colon, so nothing is invented when the body doesn't say.
 */
function consequenceMatch(label: string, body: string | null | undefined): { text: string; span: string } | undefined {
  if (!body) return undefined;
  const lead = label.split(/\s+[—–-]\s+|:\s+/)[0]?.trim();
  if (!lead || lead.length < 2) return undefined;
  const re = new RegExp(`(?:^|[.!?\\n]\\s*)(${escapeRe(lead)}\\s*:\\s*([^.!?\\n]+[.!?]?))`, 'i');
  const hit = re.exec(body);
  if (!hit) return undefined;
  const text = hit[2].trim();
  return text ? { text: text.charAt(0).toUpperCase() + text.slice(1), span: hit[1] } : undefined;
}

export function consequenceFromBody(label: string, body: string | null | undefined): string | undefined {
  return consequenceMatch(label, body)?.text;
}

/**
 * Moves each option's consequence sentence out of the explanation and onto the
 * option, so the body keeps only the framing and nothing is said twice.
 */
function withConsequences(options: QuestionOption[], body: string | null | undefined): { options: QuestionOption[]; body: string | null } {
  let rest = body ?? null;
  const out = options.map(o => {
    const m = consequenceMatch(o.label, body);
    if (m && rest) rest = rest.replace(m.span, '');
    if (o.description || !m) return o;
    return { ...o, description: m.text };
  });
  const cleaned = rest?.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.!?])/g, '$1').trim() || null;
  return { options: out, body: cleaned };
}

/**
 * What the worker already reported beside its question. A `needs_input:` error
 * carries the full question text, framing included, so a question whose brief
 * was lost (or never derived, on an older runner) still shows what failed.
 */
export interface WorkerQuestionFacts {
  workerError?: string | null;
  /** Only where the surface does not already show the task. */
  taskTitle?: string | null;
}

/**
 * The one normalized question every surface renders: task detail, Home's
 * Needs-you card, chat. Never context-free when anything is known — see
 * `fallbackQuestionContext` in @buildd/core/human-attention.
 */
export function unifyWorkerQuestion(
  waitingFor: BriefedWaitingFor,
  note: QuestionNoteLike | null,
  facts: WorkerQuestionFacts = {},
): UnifiedQuestion {
  const options = withRecommendation(normalizeOptions(waitingFor.options ?? [], note?.defaultChoice), waitingFor.recommended);
  const brief = briefOf(waitingFor);
  if (!brief.context && !note?.body?.trim()) {
    const context = fallbackQuestionContext({ prompt: waitingFor.prompt, workerError: facts.workerError, taskTitle: facts.taskTitle });
    if (context) brief.context = context;
  }
  if (!note) return { headline: waitingFor.prompt, body: null, options, noteId: null, ...brief };
  const withC = withConsequences(
    options.length ? options : note.defaultChoice ? [{ label: note.defaultChoice, recommended: true }] : [],
    note.body,
  );
  const body = note.body?.trim() ? withC.body : same(note.title, waitingFor.prompt) ? null : waitingFor.prompt;
  return { headline: note.title, body, options: withC.options, noteId: note.id, ...brief };
}

export function unifyNoteQuestion(note: QuestionNoteLike): UnifiedQuestion {
  const withC = withConsequences(note.defaultChoice ? [{ label: note.defaultChoice, recommended: true }] : [], note.body);
  return { headline: note.title, body: withC.body, options: withC.options, noteId: note.id };
}

/** The open question note that records the same ask as the worker's `waitingFor`. */
export function linkQuestionNote<N extends QuestionNoteLike>(notes: N[], workerId: string): N | null {
  const open = notes.filter(n => n.type === 'question' && n.status === 'open');
  const own = open.filter(n => n.workerId === workerId);
  if (own.length > 0) return own[own.length - 1];
  const unowned = open.filter(n => !n.workerId);
  return unowned.length === 1 && open.length === 1 ? unowned[0] : null;
}
