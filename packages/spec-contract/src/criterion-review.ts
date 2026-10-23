/**
 * What a revision changes, per criterion (Living Specs "Reviewing a spec
 * revision" R-2, R-3, R-5, R-15, R-16). Pure: computed from two revisions'
 * criterion records and their text outside criteria, never by a model.
 *
 *  - added: an id the later revision has and the earlier one does not.
 *  - changed: the same id with a different text hash.
 *  - moved: the same id and hash under a different section heading.
 *  - removed: an id the earlier revision has and the later one does not.
 *  - replacing: a criterion whose `replaces:` names ids; the replaced ids it
 *    removes are listed on it, not again as removed.
 *
 * Entries are in the later revision's order, a removed one where it stood in
 * the earlier one. Consecutive added entries fold into one range line.
 */

export interface ReviewRecord {
  id: string;
  text: string;
  textHash: string;
  section: string;
  replaces: string[];
}

/** One run of words: kept, added or removed. */
export interface WordOp { op: '=' | '+' | '-'; text: string }

export type CriterionChange =
  | { kind: 'added'; id: string; text: string; section: string }
  | { kind: 'changed'; id: string; text: string; oldText: string; words: WordOp[]; section: string; movedFrom?: string }
  | { kind: 'moved'; id: string; text: string; section: string; movedFrom: string }
  | { kind: 'removed'; id: string; oldText: string; section: string }
  | { kind: 'replacing'; id: string; text: string; section: string; replaces: Array<{ id: string; oldText: string | null }> };

/** A line of the change list: one change, or a run of two or more added ones. */
export type ChangeLine = CriterionChange | { kind: 'added-range'; label: string; items: Array<Extract<CriterionChange, { kind: 'added' }>> };

export interface SectionTextChange { kind: 'added' | 'removed' | 'changed'; section: string }

/** Above this many token pairs the word diff marks the whole text replaced. */
const MAX_WORD_CELLS = 250_000;

/** Words and the spaces between them, so joining the ops gives the text back. */
const tokens = (s: string) => s.match(/\s+|[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_]/gu) ?? [];

export function wordDiff(a: string, b: string): WordOp[] {
  const x = tokens(a); const y = tokens(b);
  const raw: WordOp[] = [];
  if (x.length * y.length > MAX_WORD_CELLS) {
    if (a) raw.push({ op: '-', text: a });
    if (b) raw.push({ op: '+', text: b });
  } else {
    const w = y.length + 1;
    const L = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        L[i * w + j] = x[i] === y[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
      }
    }
    let i = 0; let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) { raw.push({ op: '=', text: x[i]! }); i++; j++; }
      else if (L[(i + 1) * w + j]! >= L[i * w + j + 1]!) raw.push({ op: '-', text: x[i++]! });
      else raw.push({ op: '+', text: y[j++]! });
    }
    while (i < x.length) raw.push({ op: '-', text: x[i++]! });
    while (j < y.length) raw.push({ op: '+', text: y[j++]! });
  }
  return tidyWordOps(raw);
}

const hasWord = (s: string) => /[\p{L}\p{N}]/u.test(s);
const wordCount = (s: string) => s.match(/[\p{L}\p{N}_'’]+/gu)?.length ?? 0;
/** An unchanged stretch too small to be worth a break in a changed run: no words, or one short word. */
const isBridge = (s: string) => !hasWord(s) || (wordCount(s) === 1 && s.trim().length <= 4);

/**
 * Clean up a raw word diff for reading ("Reviewing a spec revision" R-17):
 * a changed run is never whitespace or punctuation alone, two changed runs
 * with one short unchanged word (or none) between them become one, and a
 * changed point is always one removed run then one added run. The kept and
 * added ops still join to the new text; the removed and kept ops join to the
 * old text except for whitespace and punctuation differences, which are not marked.
 */
export function tidyWordOps(raw: readonly WordOp[]): WordOp[] {
  // Each entry: unchanged text, or a changed point with its removed and added text.
  type Seg = { eq: string } | { del: string; add: string };
  let segs: Seg[] = [];
  for (const o of raw) {
    const last = segs[segs.length - 1];
    if (o.op === '=') {
      if (last && 'eq' in last) last.eq += o.text; else segs.push({ eq: o.text });
    } else {
      const point = last && !('eq' in last) ? last : null;
      const t = point ?? { del: '', add: '' };
      if (o.op === '-') t.del += o.text; else t.add += o.text;
      if (!point) segs.push(t);
    }
  }
  // Absorb small unchanged stretches between two changed points.
  for (let again = true; again;) {
    again = false;
    const next: Seg[] = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!; const prev = next[next.length - 1]; const after = segs[i + 1];
      if ('eq' in s && prev && !('eq' in prev) && after && !('eq' in after) && isBridge(s.eq)) {
        prev.del += s.eq + after.del; prev.add += s.eq + after.add;
        i++; again = true;
      } else next.push(s);
    }
    segs = next;
  }
  const out: WordOp[] = [];
  const push = (op: WordOp['op'], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text; else out.push({ op, text });
  };
  for (const s of segs) {
    if ('eq' in s) push('=', s.eq);
    else if (!hasWord(s.del) && !hasWord(s.add)) push('=', s.add || s.del);
    else { push('-', s.del); push('+', s.add); }
  }
  return out;
}

/** True when more than a third of the words changed: read it as Was and Now, not as inline marks (R-18). */
export function mostlyRewritten(words: readonly WordOp[]): boolean {
  let changed = 0; let total = 0;
  for (const w of words) {
    const n = wordCount(w.text);
    total += n;
    if (w.op !== '=') changed += n;
  }
  return total > 0 && changed * 3 > total;
}

const idParts = (id: string) => {
  const m = /^([A-Z]+)-(\d+)$/.exec(id);
  return m ? { kind: m[1]!, n: Number(m[2]) } : null;
};

/** Ids as ranges: R-44, R-45, R-46, AC-2 reads "R-44 – R-46, AC-2". Order is kept. */
export function idRanges(ids: readonly string[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < ids.length) {
    const a = idParts(ids[i]!);
    let j = i;
    while (a && j + 1 < ids.length) {
      const b = idParts(ids[j + 1]!);
      if (!b || b.kind !== a.kind || b.n !== a.n + (j + 1 - i)) break;
      j++;
    }
    parts.push(j > i ? `${ids[i]} – ${ids[j]}` : ids[i]!);
    i = j + 1;
  }
  return parts.join(', ');
}

export function criterionChanges(from: readonly ReviewRecord[], to: readonly ReviewRecord[]): CriterionChange[] {
  const before = new Map(from.map((r) => [r.id, r]));
  const after = new Set(to.map((r) => r.id));
  // A removed id that a criterion of the later revision replaces is listed on that criterion.
  const replacedHere = new Set(to.flatMap((r) => r.replaces).filter((id) => before.has(id) && !after.has(id)));
  const out: CriterionChange[] = [];
  const removed = (r: ReviewRecord) => { if (!replacedHere.has(r.id)) out.push({ kind: 'removed', id: r.id, oldText: r.text, section: r.section }); };
  let fi = 0;
  for (const r of to) {
    const old = before.get(r.id);
    if (old) {
      // Removed criteria that stood before this one in the earlier revision read before it.
      for (; fi < from.length && from[fi] !== old; fi++) if (!after.has(from[fi]!.id)) removed(from[fi]!);
      fi++;
    }
    const replaces = r.replaces.filter((id) => id !== r.id && !after.has(id));
    if (!old && replaces.length) {
      out.push({ kind: 'replacing', id: r.id, text: r.text, section: r.section, replaces: replaces.map((id) => ({ id, oldText: before.get(id)?.text ?? null })) });
    } else if (!old) {
      out.push({ kind: 'added', id: r.id, text: r.text, section: r.section });
    } else if (old.textHash !== r.textHash) {
      out.push({ kind: 'changed', id: r.id, text: r.text, oldText: old.text, words: wordDiff(old.text, r.text), section: r.section, ...(old.section !== r.section ? { movedFrom: old.section } : {}) });
    } else if (old.section !== r.section) {
      out.push({ kind: 'moved', id: r.id, text: r.text, section: r.section, movedFrom: old.section });
    }
  }
  for (; fi < from.length; fi++) if (!after.has(from[fi]!.id)) removed(from[fi]!);
  return out;
}

/** The change list as lines: two or more consecutive added criteria fold into one range (R-2). */
export function changeLines(changes: readonly CriterionChange[]): ChangeLine[] {
  const out: ChangeLine[] = [];
  let run: Array<Extract<CriterionChange, { kind: 'added' }>> = [];
  const flush = () => {
    if (run.length >= 2) out.push({ kind: 'added-range', label: idRanges(run.map((r) => r.id)), items: run });
    else out.push(...run);
    run = [];
  };
  for (const c of changes) {
    if (c.kind === 'added') { run.push(c); continue; }
    flush();
    out.push(c);
  }
  flush();
  return out;
}

/** Sections whose text outside criteria was added, removed or changed, in the later revision's order (R-3). */
export function otherTextChanges(from: ReadonlyMap<string, string>, to: ReadonlyMap<string, string>): SectionTextChange[] {
  const out: SectionTextChange[] = [];
  const fromKeys = [...from.keys()];
  const gone = (k: string) => !to.has(k) && (from.get(k) ?? '') !== '';
  let fi = 0;
  for (const [k, text] of to) {
    if (from.has(k)) {
      // Sections removed before this one in the earlier revision read before it.
      for (; fi < fromKeys.length && fromKeys[fi] !== k; fi++) if (gone(fromKeys[fi]!)) out.push({ kind: 'removed', section: fromKeys[fi]! });
      fi++;
      const old = from.get(k) ?? '';
      if (old !== text) out.push({ kind: old && text ? 'changed' : text ? 'added' : 'removed', section: k });
    } else {
      // A section removed at this spot reads before the one that took its place.
      for (; fi < fromKeys.length && !to.has(fromKeys[fi]!); fi++) if (gone(fromKeys[fi]!)) out.push({ kind: 'removed', section: fromKeys[fi]! });
      if (text) out.push({ kind: 'added', section: k });
    }
  }
  for (; fi < fromKeys.length; fi++) if (gone(fromKeys[fi]!)) out.push({ kind: 'removed', section: fromKeys[fi]! });
  return out;
}

const RANGE = /\b(R|AC)-(\d+)\s*(?:to|through|\u2013|\u2014|-|\.\.)\s*(?:(R|AC)-)?(\d+)\b/g;
const ONE = /\b(R|AC)-(\d+)\b/g;

/** The R-n / AC-n ids a change summary names, ranges ("R-11 to R-16", "AC-6 – AC-9") expanded. */
export function summaryIds(summary: string): Set<string> {
  const out = new Set<string>();
  for (const m of summary.matchAll(RANGE)) {
    if (m[3] && m[3] !== m[1]) continue;
    const a = Number(m[2]); const b = Number(m[4]);
    if (b >= a && b - a <= 200) for (let n = a; n <= b; n++) out.add(`${m[1]}-${n}`);
  }
  for (const m of summary.matchAll(ONE)) out.add(`${m[1]}-${Number(m[2])}`);
  return out;
}

export interface SummaryMismatch {
  /** Criteria the revision changes that the summary does not name. */
  unmentioned: string[];
  /** Ids the summary names that the revision does not change. */
  unchanged: string[];
}

/**
 * Compare the ids a change summary names with the ids the change list holds
 * (R-5). Mechanical: ids only. A moved criterion may be named but need not
 * be; a replacing criterion counts as named when it or an id it replaces is.
 * Null when there is no summary or nothing differs.
 */
export function summaryMismatch(summary: string | null | undefined, changes: readonly CriterionChange[]): SummaryMismatch | null {
  if (!summary || !summary.trim()) return null;
  const named = summaryIds(summary);
  const touched = new Set<string>();
  const unmentioned: string[] = [];
  for (const c of changes) {
    const ids = c.kind === 'replacing' ? [c.id, ...c.replaces.map((r) => r.id)] : [c.id];
    for (const id of ids) touched.add(id);
    if (c.kind === 'moved') continue;
    if (!ids.some((id) => named.has(id))) unmentioned.push(c.id);
  }
  const unchanged = [...named].filter((id) => !touched.has(id));
  return unmentioned.length || unchanged.length ? { unmentioned, unchanged } : null;
}

const joinIds = (ids: readonly string[]) => {
  const r = idRanges(ids).split(', ');
  return r.length > 1 ? `${r.slice(0, -1).join(', ')} and ${r[r.length - 1]}` : r[0]!;
};

/** The mismatch in one line: "The summary does not mention R-25, which changed." */
export function summaryMismatchLine(m: SummaryMismatch | null): string | null {
  if (!m) return null;
  const parts: string[] = [];
  if (m.unmentioned.length) parts.push(`The summary does not mention ${joinIds(m.unmentioned)}, which changed.`);
  if (m.unchanged.length) parts.push(`${m.unmentioned.length ? 'It' : 'The summary'} names ${joinIds(m.unchanged)}, which this revision does not change.`);
  return parts.join(' ');
}
