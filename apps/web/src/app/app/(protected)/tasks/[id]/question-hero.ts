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
      out.push({
        label: o.label,
        ...(o.description ? { description: o.description } : {}),
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
 * option's lead phrase (before an em dash) is matched, and only a phrase
 * followed by a colon, so nothing is invented when the body doesn't say.
 */
function consequenceMatch(label: string, body: string | null | undefined): { text: string; span: string } | undefined {
  if (!body) return undefined;
  const lead = label.split(/\s+[—–-]\s+/)[0]?.trim();
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

export function unifyWorkerQuestion(
  waitingFor: { prompt: string; options?: WaitingForOption[] | null; type?: string },
  note: QuestionNoteLike | null,
): UnifiedQuestion {
  const options = normalizeOptions(waitingFor.options ?? [], note?.defaultChoice);
  if (!note) return { headline: waitingFor.prompt, body: null, options, noteId: null };
  const withC = withConsequences(
    options.length ? options : note.defaultChoice ? [{ label: note.defaultChoice, recommended: true }] : [],
    note.body,
  );
  const body = note.body?.trim() ? withC.body : same(note.title, waitingFor.prompt) ? null : waitingFor.prompt;
  return { headline: note.title, body, options: withC.options, noteId: note.id };
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
