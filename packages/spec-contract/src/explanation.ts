import { otherTextBySection } from './criterion-records';
import { wordDiff, type ChangeLine, type CriterionChange, type SectionTextChange, type WordOp } from './criterion-review';

/**
 * A revision's explanation ("Approving specs from a session" R-15 to R-19):
 * what the agent that wrote the revision says it changes, as a one-line
 * summary and one plain-language line per changed criterion (keyed by its id)
 * or changed section outside the criteria (keyed by its heading). Stored with
 * the revision, never edited, never written by a model at read time.
 *
 * The coverage check is mechanical: it compares the keys with the real
 * change list. It confirms the explanation mentions every change, not that
 * what it says is right.
 */
export interface SpecExplanation {
  summary: string;
  /** One sentence naming the decision the author needs from the reader; leads the inbox row, the confirm page and Review all. */
  question?: string;
  lines: Record<string, string>;
}

export const EXPLANATION_SUMMARY_MAX = 300;
export const EXPLANATION_QUESTION_MAX = 300;
export const EXPLANATION_LINE_MAX = 1000;
export const EXPLANATION_KEY_MAX = 300;
export const EXPLANATION_LINES_MAX = 300;

const CRITERION = /^(R|AC)-(\d+)$/i;

/** A criterion id in its one spelling (r-01 reads R-1); a section key is trimmed. */
function normalKey(key: string): string {
  const k = key.trim();
  const m = CRITERION.exec(k);
  return m ? `${m[1]!.toUpperCase()}-${Number(m[2])}` : k;
}

const RANGE_PART = /^(R|AC)-(\d+)\s*(?:to|through|\u2013|\u2014|-|\.\.)\s*(?:(R|AC)-)?(\d+)$/i;

/**
 * The criterion ids a key names when it is a range or a list ("R-201 to
 * R-235", "AC-6 – AC-9", "R-3, R-5 and R-7"): each id once, in order. Null
 * when the key is one id or a heading. A range runs one kind, low to high, at
 * most EXPLANATION_LINES_MAX ids.
 */
export function explanationKeyIds(key: string): string[] | null {
  const parts = key.trim().split(/\s*(?:,|;|\band\b|&)\s*/i).filter(Boolean);
  const out: string[] = [];
  let ranged = false;
  for (const part of parts) {
    const one = CRITERION.exec(part);
    if (one) { out.push(normalKey(part)); continue; }
    const r = RANGE_PART.exec(part);
    if (!r) return null;
    const kind = r[1]!.toUpperCase();
    if (r[3] && r[3].toUpperCase() !== kind) return null;
    const a = Number(r[2]); const b = Number(r[4]);
    if (b < a || b - a >= EXPLANATION_LINES_MAX) return null;
    for (let n = a; n <= b; n++) out.push(`${kind}-${n}`);
    ranged = true;
  }
  return ranged || out.length > 1 ? out : null;
}

/** Read an explanation from a request: null when omitted, an error naming the field when malformed. */
export function parseExplanation(input: unknown): { ok: true; explanation: SpecExplanation | null } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, explanation: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'explanation must be { summary, lines: { "<criterion id or section heading>": "<what changed>" } }' };
  const { summary, lines, question } = input as { summary?: unknown; lines?: unknown; question?: unknown };
  if (typeof summary !== 'string' || !summary.trim()) return { ok: false, error: 'explanation.summary (one line saying what the revision does) is required' };
  if (/[\r\n]/.test(summary.trim()) || summary.trim().length > EXPLANATION_SUMMARY_MAX) return { ok: false, error: `explanation.summary is one line of at most ${EXPLANATION_SUMMARY_MAX} characters` };
  let asked: string | undefined;
  if (question !== undefined && question !== null) {
    if (typeof question !== 'string' || !question.trim()) return { ok: false, error: 'explanation.question must be one sentence naming the decision you need, or omitted' };
    if (/[\r\n]/.test(question.trim()) || question.trim().length > EXPLANATION_QUESTION_MAX) return { ok: false, error: `explanation.question is one line of at most ${EXPLANATION_QUESTION_MAX} characters` };
    asked = question.trim();
  }
  if (lines !== undefined && (typeof lines !== 'object' || lines === null || Array.isArray(lines))) return { ok: false, error: 'explanation.lines must be an object keyed by criterion id (R-3) or section heading' };
  const out: Record<string, string> = {};
  const entries = Object.entries((lines ?? {}) as Record<string, unknown>);
  if (entries.length > EXPLANATION_LINES_MAX) return { ok: false, error: `explanation.lines holds at most ${EXPLANATION_LINES_MAX} lines` };
  for (const [rawKey, text] of entries) {
    const key = normalKey(rawKey);
    if (!key || key.length > EXPLANATION_KEY_MAX) return { ok: false, error: `explanation.lines keys are a criterion id or a section heading of at most ${EXPLANATION_KEY_MAX} characters` };
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: `explanation.lines["${rawKey}"] must be a line of text` };
    if (text.trim().length > EXPLANATION_LINE_MAX) return { ok: false, error: `explanation.lines["${rawKey}"] is at most ${EXPLANATION_LINE_MAX} characters` };
    // "R-201 to R-235" is one line for each id it names, stored one key per id.
    for (const k of explanationKeyIds(key) ?? [key]) {
      if (k in out) return { ok: false, error: `explanation.lines names ${k} twice` };
      out[k] = text.trim();
    }
  }
  if (Object.keys(out).length > EXPLANATION_LINES_MAX) return { ok: false, error: `explanation.lines holds at most ${EXPLANATION_LINES_MAX} lines, ranges counted one per id` };
  return { ok: true, explanation: { summary: summary.trim(), ...(asked ? { question: asked } : {}), lines: out } };
}

/** One change the explanation has to cover. */
export type CoverageItem =
  | { kind: 'criterion'; key: string; change: Exclude<CriterionChange['kind'], 'moved'>; criterion: CriterionChange; explanation: string | null }
  | { kind: 'section'; key: string; change: SectionTextChange['kind']; explanation: string | null };

export interface ExplanationCoverage {
  /** Changes that need explaining: criteria added, changed, removed or replacing, and sections outside the criteria. */
  total: number;
  covered: number;
  items: CoverageItem[];
  notExplained: CoverageItem[];
  /** Lines naming a criterion or section this revision does not change (or that does not exist). */
  extra: Array<{ key: string; text: string }>;
  passed: boolean;
  /** "Explanation covers 5 of 5 changes", "Covers 3 of 5: 2 not explained". */
  line: string;
}

const PREAMBLE = 'Before the first heading';
/**
 * A heading as a person writes it: no # marks, › or > between parts, case and
 * spacing ignored, and inline markdown ignored (`await_answer`, **Bold**,
 * await_answer and awaitanswer are one heading: the section path drops the
 * marks, so a key keeps working however it was copied).
 */
const headingKey = (s: string) => s.replace(/^#+\s*/, '').split(/\s*[>›]\s*/).map((p) => p.replace(/^#+\s*/, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean).join(' > ');
const lastPart = (path: string) => { const p = path.split(' > '); return p[p.length - 1]!; };

/**
 * Compare an explanation with what the revision really changes (R-16). No
 * model: ids against ids, headings against headings. A section line matches a
 * changed section by its full heading path or by its own heading.
 */
export function explanationCoverage(explanation: SpecExplanation | null, lines: readonly ChangeLine[], otherText: readonly SectionTextChange[]): ExplanationCoverage {
  const given = new Map(Object.entries(explanation?.lines ?? {}).flatMap(([k, v]) => (explanationKeyIds(normalKey(k)) ?? [normalKey(k)]).map((id) => [id, v] as const)));
  const used = new Set<string>();
  const take = (k: string) => { const v = given.get(k); if (v !== undefined) used.add(k); return v ?? null; };
  const items: CoverageItem[] = [];
  const changes = lines.flatMap((l) => (l.kind === 'added-range' ? l.items : [l]));
  for (const c of changes) {
    if (c.kind === 'moved') { take(c.id); continue; }
    const ids = c.kind === 'replacing' ? [c.id, ...c.replaces.map((r) => r.id)] : [c.id];
    let text: string | null = null;
    for (const id of ids) text = take(id) ?? text;
    items.push({ kind: 'criterion', key: c.id, change: c.kind, criterion: c, explanation: text });
  }
  const sectionKeys = [...given.keys()].filter((k) => !CRITERION.test(k));
  for (const o of otherText) {
    const full = headingKey(o.section || PREAMBLE);
    const own = headingKey(lastPart(o.section) || PREAMBLE);
    let text: string | null = null;
    for (const k of sectionKeys) {
      const hk = headingKey(k);
      if (hk === full || hk === own) { used.add(k); text = text ?? given.get(k)!; }
    }
    items.push({ kind: 'section', key: o.section, change: o.kind, explanation: text });
  }
  const notExplained = items.filter((i) => i.explanation === null);
  const extra = [...given].filter(([k]) => !used.has(k)).map(([key, text]) => ({ key, text }));
  const total = items.length;
  const covered = total - notExplained.length;
  const noun = (n: number) => (n === 1 ? 'change' : 'changes');
  const line = total === 0
    ? 'No criterion or section changed'
    : !explanation
      ? `No explanation: 0 of ${total} ${noun(total)} explained`
      : covered === total
        ? `Explanation covers ${covered} of ${total} ${noun(total)}`
        : `Covers ${covered} of ${total}: ${total - covered} not explained`;
  return { total, covered, items, notExplained, extra, passed: notExplained.length === 0, line };
}

/** The changed words of each section's text outside the criteria (R-17), keyed by heading path. */
export function sectionWordChanges(fromBody: string, toBody: string, otherText: readonly SectionTextChange[]): Record<string, WordOp[]> {
  const a = otherTextBySection(fromBody);
  const b = otherTextBySection(toBody);
  const out: Record<string, WordOp[]> = {};
  for (const o of otherText) out[o.section] = wordDiff(a.get(o.section) ?? '', b.get(o.section) ?? '');
  return out;
}

/** The question that leads a row or page, or null when the author asked none. */
export function questionToLead(explanation: SpecExplanation | null | undefined): string | null {
  return explanation?.question?.trim() || null;
}
