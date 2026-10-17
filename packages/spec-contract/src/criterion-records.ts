import { requirementIds, tableRowId } from './requirements';
import { criterionLines } from './check-lines';

/**
 * Criteria as records (Living Specs "Reviewing a spec revision" R-11 to R-16).
 * Every R-n and AC-n of a revision, derived from its body: its words, the
 * section heading it sits under, its `check:`, `screen:` and `replaces:`
 * lines. The body stays what people write and read; a record is never edited
 * on its own, only derived again from the text.
 *
 * A criterion's words are its defining line (the id and its punctuation
 * dropped, as requirementIds reads it) and the lines under it, up to a blank
 * line, the next id, a heading, a fence or (for a list item) the next item at
 * its level. Labelled lines (`check:`, `screen:`, `replaces:`) are not words:
 * they are kept apart, so a changed check is not a changed criterion. A table
 * row's words are its other cells. Each line is trimmed, so re-indenting
 * changes nothing.
 *
 * Pure: the host hashes the words (sha256 of the UTF-8 text, as contentHash)
 * and stores the records.
 */

export interface CriterionRecord {
  id: string;
  kind: 'requirement' | 'acceptance';
  /** Order in the body, from 0. */
  position: number;
  /** 1-based line of the definition. */
  line: number;
  /** The criterion's words. */
  text: string;
  /** The heading path it sits under ("Requirements > What Review shows"); '' before the first heading. */
  section: string;
  checks: string[];
  screens: string[];
  /** Ids this criterion replaces (`replaces: R-26, R-27`). */
  replaces: string[];
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const LABEL = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?(?:check|screens?|replaces)(?:\*\*|__)?\s*:/i;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+\.)\s+/;
const PLAIN_ID = /^(R|AC)-(\d+)$/;

/** The heading path each line of `body` sits under, by index; fenced lines keep the path above them. */
export function sectionPaths(body: string): string[] {
  const trail: string[] = [];
  const out: string[] = [];
  let fenced = false;
  for (const raw of body.split('\n')) {
    if (FENCE.test(raw)) fenced = !fenced;
    const m = fenced ? null : HEADING.exec(raw);
    if (m) {
      const level = m[1]!.length;
      trail.length = level - 1;
      trail[level - 1] = m[2]!.replace(/[*_`]/g, '').trim();
    }
    out.push(trail.filter(Boolean).join(' > '));
  }
  return out;
}

/** The ids a `replaces:` value names, plain R-n / AC-n only, in order, once each. */
export function replacedIds(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(/[,\s]+/)) {
    const t = part.replace(/[`*_.;]/g, '').trim();
    const m = PLAIN_ID.exec(t);
    const id = m ? `${m[1]}-${Number(m[2])}` : null;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The lines (0-based) that are a criterion's words, per id: the definition and
 * its continuation lines. Label lines are not included.
 */
function criterionSpans(body: string): Map<string, number[]> {
  const lines = body.split('\n');
  const defs = requirementIds(body);
  const starts = new Set(defs.map((d) => d.line - 1));
  const out = new Map<string, number[]>();
  for (const d of defs) {
    if (d.kind !== 'requirement' && d.kind !== 'acceptance') continue;
    const at = d.line - 1;
    const span = [at];
    if (!tableRowId(lines[at]!)) {
      const item = LIST_ITEM.exec(lines[at]!);
      for (let i = at + 1; i < lines.length; i++) {
        const raw = lines[i]!;
        if (!raw.trim() || starts.has(i) || HEADING.test(raw) || FENCE.test(raw)) break;
        const sub = LIST_ITEM.exec(raw);
        if (item && sub && sub[1]!.length <= item[1]!.length) break;
        if (LABEL.test(raw)) continue;
        span.push(i);
      }
    }
    out.set(d.id, span);
  }
  return out;
}

export function criterionRecords(body: string): CriterionRecord[] {
  const lines = body.split('\n');
  const paths = sectionPaths(body);
  const spans = criterionSpans(body);
  const checks = new Map<string, string[]>();
  const screens = new Map<string, string[]>();
  const replaces = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, id: string, vs: string[]) => {
    const list = m.get(id) ?? [];
    for (const v of vs) if (v && !list.includes(v)) list.push(v);
    m.set(id, list);
  };
  for (const { criterionId, value } of criterionLines(body, 'check')) push(checks, criterionId, [value.replace(/^`+|`+$/g, '').trim()]);
  for (const { criterionId, value } of criterionLines(body, 'screens?')) push(screens, criterionId, value.split(',').map((x) => x.replace(/`/g, '').trim()));
  for (const { criterionId, value } of criterionLines(body, 'replaces')) push(replaces, criterionId, replacedIds(value));

  const out: CriterionRecord[] = [];
  for (const d of requirementIds(body)) {
    if (d.kind !== 'requirement' && d.kind !== 'acceptance') continue;
    const span = spans.get(d.id) ?? [d.line - 1];
    const words = [d.text, ...span.slice(1).map((i) => lines[i]!.trim())].filter(Boolean);
    out.push({
      id: d.id, kind: d.kind, position: out.length, line: d.line,
      text: words.join('\n'),
      section: paths[d.line - 1] ?? '',
      checks: checks.get(d.id) ?? [],
      screens: screens.get(d.id) ?? [],
      replaces: (replaces.get(d.id) ?? []).filter((r) => r !== d.id),
    });
  }
  return out;
}

/**
 * Each section's text outside its criteria, by heading path: what "Other
 * text" compares (R-3). A criterion's words are left out; its labelled lines
 * (check, screen, replaces) stay, so a changed check line shows here.
 */
export function otherTextBySection(body: string): Map<string, string> {
  const lines = body.split('\n');
  const paths = sectionPaths(body);
  const skip = new Set<number>();
  for (const span of criterionSpans(body).values()) for (const i of span) skip.add(i);
  const out = new Map<string, string[]>();
  lines.forEach((raw, i) => {
    const key = paths[i]!;
    const list = out.get(key) ?? [];
    if (!skip.has(i) && raw.trim()) list.push(raw.trim());
    out.set(key, list);
  });
  return new Map([...out].map(([k, v]) => [k, v.join('\n')]));
}
