import { db } from '@buildd/core/db';
import { specRevisions, specs } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { outlineOf } from '@buildd/core/artifact-read';
import { isUuid } from '@/lib/uuid';
import { getArtifactRevision } from '@/lib/artifact-revisions';
import { recordArtifactRead } from '@/lib/artifact-reads';
import { fail, reach, type SpecCaller, type SpecError } from './store';

/**
 * What changed between two revisions of a Living Spec, read-only: which
 * sections were added, removed or changed (by their Markdown heading path,
 * the same headings the artifact outline view uses), then a unified line
 * diff of those sections, capped with an explicit count of what it left out.
 *
 * Sections are matched by heading path ("Checkout > Totals"), so a renamed
 * heading reads as one section removed and one added. A section's own text
 * runs from its heading to the next heading of any level: a change in a
 * subsection is reported on the subsection, not on every ancestor.
 */

export const MAX_DIFF_LINES = 400;
export const MAX_DIFF_CHARS = 20_000;
/** Above this many line pairs in one section the diff stops looking for common lines and reports the section as replaced. */
const MAX_LCS_CELLS = 4_000_000;
const CONTEXT = 2;

export interface SectionChange {
  kind: 'added' | 'removed' | 'changed';
  /** Heading path, e.g. "Checkout > Totals"; "(before the first heading)" for the preamble. */
  path: string;
  level: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface SpecBodyDiff {
  identical: boolean;
  sections: SectionChange[];
  /** Unified diff of the changed sections, one `@@ path @@` hunk header per section. */
  diff: string;
  /** Diff lines left out by the caps. */
  omittedLines: number;
}

/** One line of a section's diff, numbered in the revision it belongs to; a `gap` row stands for elided unchanged lines. */
export interface DiffRow { op: ' ' | '-' | '+' | 'gap'; oldLine: number | null; newLine: number | null; text: string }

export interface DiffHunk {
  kind: SectionChange['kind'];
  path: string;
  linesAdded: number;
  linesRemoved: number;
  rows: DiffRow[];
}

/** The same diff as SpecBodyDiff.diff, as rows for a reader: same sections, same context, same caps. */
export interface SpecBodyHunks {
  hunks: DiffHunk[];
  omittedLines: number;
}

/** `startLine`: the 1-based line of the body the section's first line sits on. */
interface OwnSection { key: string; path: string; level: number; lines: string[]; startLine: number }

const PREAMBLE = '(before the first heading)';

function ownSections(body: string): OwnSection[] {
  const outline = outlineOf(body);
  const out: OwnSection[] = [];
  const split = (s: string) => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));
  const first = outline[0]?.start ?? body.length;
  if (first > 0 && body.slice(0, first).trim()) out.push({ key: PREAMBLE, path: PREAMBLE, level: 0, lines: split(body.slice(0, first)), startLine: 1 });
  const trail: string[] = [];
  const seen = new Map<string, number>();
  // Line numbers counted forward once, not re-scanned from the top per section.
  let line = 1; let at = 0;
  const lineAt = (offset: number) => {
    for (; at < offset; at++) if (body.charCodeAt(at) === 10) line++;
    return line;
  };
  outline.forEach((s, i) => {
    trail.length = s.level - 1;
    trail[s.level - 1] = s.title;
    const path = trail.filter(Boolean).join(' > ');
    const n = (seen.get(path) ?? 0) + 1;
    seen.set(path, n);
    const end = outline[i + 1]?.start ?? body.length;
    out.push({ key: n === 1 ? path : `${path} #${n}`, path: n === 1 ? path : `${path} (${n})`, level: s.level, lines: split(body.slice(s.start, end)), startLine: lineAt(s.start) });
  });
  return out;
}

type Op = { op: ' ' | '-' | '+'; text: string };

/** Line diff: common prefix and suffix, then a longest-common-subsequence on the middle. */
export function diffLines(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const x = a.slice(pre, a.length - suf);
  const y = b.slice(pre, b.length - suf);
  const mid: Op[] = [];
  if (x.length * y.length > MAX_LCS_CELLS) {
    for (const t of x) mid.push({ op: '-', text: t });
    for (const t of y) mid.push({ op: '+', text: t });
  } else {
    const w = y.length + 1;
    const L = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        L[i * w + j] = x[i] === y[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
      }
    }
    let i = 0; let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) { mid.push({ op: ' ', text: x[i] }); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) mid.push({ op: '-', text: x[i++] });
      else mid.push({ op: '+', text: y[j++] });
    }
    while (i < x.length) mid.push({ op: '-', text: x[i++] });
    while (j < y.length) mid.push({ op: '+', text: y[j++] });
  }
  return [...a.slice(0, pre).map((t) => ({ op: ' ' as const, text: t })), ...mid, ...b.slice(b.length - suf).map((t) => ({ op: ' ' as const, text: t }))];
}

/**
 * The changed lines with CONTEXT lines around each run, numbered from where
 * the section starts in each revision; elided context before or between runs
 * becomes one gap row.
 */
function withContext(ops: Op[], oldStart: number, newStart: number): DiffRow[] {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.op === ' ') return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) keep[k] = true;
  });
  const out: DiffRow[] = [];
  let gap = false;
  let oldLine = oldStart; let newLine = newStart;
  ops.forEach((o, i) => {
    const row: DiffRow = { op: o.op, oldLine: o.op === '+' ? null : oldLine, newLine: o.op === '-' ? null : newLine, text: o.text };
    if (o.op !== '+') oldLine++;
    if (o.op !== '-') newLine++;
    if (!keep[i]) { gap = true; return; }
    if (gap) out.push({ op: 'gap', oldLine: null, newLine: null, text: '' });
    gap = false;
    out.push(row);
  });
  return out;
}

const rowText = (r: DiffRow) => (r.op === 'gap' ? '...' : `${r.op}${r.text}`);

type Computed = { identical: true } | { identical: false; sections: SectionChange[]; only: true } | {
  identical: false; sections: SectionChange[]; only: false;
  /** Each changed section's hunk header and rows, in document order, under the caps. */
  hunks: DiffHunk[]; diff: string; omittedLines: number;
};

function compute(from: string, to: string): Computed {
  if (from === to) return { identical: true };
  const a = ownSections(from);
  const b = ownSections(to);
  const aByKey = new Map(a.map((s) => [s.key, s]));
  const bKeys = new Set(b.map((s) => s.key));
  const sections: SectionChange[] = [];
  const blocks: { header: string; hunk: Omit<DiffHunk, 'rows'>; rows: DiffRow[] }[] = [];
  const add = (kind: SectionChange['kind'], s: OwnSection, ops: Op[], oldStart: number, newStart: number) => {
    const change = { kind, path: s.path, level: s.level, linesAdded: ops.filter((o) => o.op === '+').length, linesRemoved: ops.filter((o) => o.op === '-').length };
    sections.push(change);
    blocks.push({ header: `@@ ${s.path} (${kind}) @@`, hunk: { kind, path: s.path, linesAdded: change.linesAdded, linesRemoved: change.linesRemoved }, rows: withContext(ops, oldStart, newStart) });
  };
  const removed = (s: OwnSection) => add('removed', s, s.lines.map((t) => ({ op: '-', text: t })), s.startLine, 0);
  // Document order of the new revision, with removed sections where they stood in the old one.
  let ai = 0;
  for (const s of b) {
    const old = aByKey.get(s.key);
    if (old) {
      for (; ai < a.length && a[ai] !== old; ai++) if (!bKeys.has(a[ai].key)) removed(a[ai]);
      ai++;
      const ops = diffLines(old.lines, s.lines);
      if (ops.some((o) => o.op !== ' ')) add('changed', s, ops, old.startLine, s.startLine);
    } else {
      // A section removed at this spot reads before the one that took its place.
      for (; ai < a.length && !bKeys.has(a[ai].key); ai++) removed(a[ai]);
      add('added', s, s.lines.map((t) => ({ op: '+', text: t })), 0, s.startLine);
    }
  }
  for (; ai < a.length; ai++) if (!bKeys.has(a[ai].key)) removed(a[ai]);
  // Only whitespace between sections changed (a trailing newline): say so rather than show nothing.
  if (!sections.length) return { identical: false, sections: [], only: true };

  const out: string[] = [];
  const hunks: DiffHunk[] = [];
  let chars = 0; let omitted = 0;
  const fits = (line: string) => {
    if (out.length < MAX_DIFF_LINES && chars + line.length + 1 <= MAX_DIFF_CHARS) { out.push(line); chars += line.length + 1; return true; }
    omitted++;
    return false;
  };
  for (const blk of blocks) {
    const hunk: DiffHunk | null = fits(blk.header) ? { ...blk.hunk, rows: [] } : null;
    if (hunk) hunks.push(hunk);
    for (const r of blk.rows) if (fits(rowText(r)) && hunk) hunk.rows.push(r);
  }
  return { identical: false, sections, only: false, hunks, diff: out.join('\n'), omittedLines: omitted };
}

export function diffSpecBodies(from: string, to: string): SpecBodyDiff {
  const c = compute(from, to);
  if (c.identical) return { identical: true, sections: [], diff: '', omittedLines: 0 };
  if (c.only) return { identical: false, sections: [], diff: '(only blank lines or trailing whitespace changed)', omittedLines: 0 };
  return { identical: false, sections: c.sections, diff: c.diff, omittedLines: c.omittedLines };
}

/** diffSpecBodies as numbered rows, for the approval page. */
export function diffSpecHunks(from: string, to: string): SpecBodyHunks {
  const c = compute(from, to);
  return c.identical || c.only ? { hunks: [], omittedLines: 0 } : { hunks: c.hunks, omittedLines: c.omittedLines };
}

export interface SpecRevisionDiff extends SpecBodyDiff {
  specId: string;
  from: { revision: number; contentHash: string; approved: boolean };
  to: { revision: number; contentHash: string; approved: boolean };
  /** With `rows`: the same diff as numbered rows, and the whole `to` body (the approval page shows both). */
  hunks?: DiffHunk[];
  toBody?: string;
}

/**
 * Diff two revisions of a spec. `to` defaults to the head; `from` to the
 * approved revision when there is one (so an approver sees what a proposal
 * changes), else the revision before `to`. Both bodies are read from the
 * artifact revision each spec revision pins and checked against its hash;
 * each read is recorded in the read ledger.
 */
export async function diffSpecRevisions(caller: SpecCaller, specId: string, opts: { from?: number; to?: number; rows?: boolean } = {}): Promise<{ ok: true; diff: SpecRevisionDiff } | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, false))) return fail(404, 'Spec not found');
  const to = opts.to ?? spec.headRevision;
  const from = opts.from ?? (spec.approvedRevision ?? to - 1);
  if (from < 1) return fail(400, `Revision ${to} is the first revision: name a revision to compare it with`);
  const rows = await db.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), inArray(specRevisions.revision, [from, to])));
  const byN = new Map(rows.map((r) => [r.revision, r]));
  for (const n of [from, to]) if (!byN.has(n)) return fail(404, `Spec has no revision ${n}`);

  const bodies: string[] = [];
  for (const n of [from, to]) {
    const rev = byN.get(n)!;
    const body = await getArtifactRevision(spec.bodyArtifactId, rev.artifactRevision);
    if (!body || typeof body.content !== 'string' || body.contentHash !== rev.contentHash) {
      return fail(409, `The body of revision ${n} is missing or does not match its hash`);
    }
    bodies.push(body.content);
  }

  const d = diffSpecBodies(bodies[0], bodies[1]);
  const numbered = opts.rows ? diffSpecHunks(bodies[0], bodies[1]) : null;
  const account = caller.kind === 'account' ? caller.account : null;
  for (const [i, n] of [from, to].entries()) {
    recordArtifactRead({
      artifactId: spec.bodyArtifactId, revision: byN.get(n)!.artifactRevision, workspaceId: spec.workspaceId,
      accountId: account?.id ?? null, userId: caller.kind === 'user' ? caller.userId : null, taskId: (account?.taskScope as { taskId?: string } | undefined)?.taskId ?? null,
      // The ledger has no diff view: the whole body was read server-side, the selector says it was for a diff.
      view: 'full', selector: { diff: { specRevision: n, against: i === 0 ? to : from } },
      returnedChars: numbered && i === 1 ? bodies[1].length : d.diff.length, totalChars: bodies[i].length,
    });
  }
  const side = (n: number) => ({ revision: n, contentHash: byN.get(n)!.contentHash, approved: spec.approvedRevision === n });
  return { ok: true, diff: { specId, from: side(from), to: side(to), ...d, ...(numbered ? { hunks: numbered.hunks, toBody: bodies[1] } : {}) } };
}
