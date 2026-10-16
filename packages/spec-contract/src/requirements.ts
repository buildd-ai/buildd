/**
 * Stable ids in a spec body: requirements (R-1), acceptance criteria (AC-1),
 * decisions (D-1) and invariants (I-1). Parsed, not stored: the body is the
 * source, so an id means exactly what that revision's text says. An id counts
 * where it starts a line, a list item, a heading or a bold label:
 * "R-1: ...", "- **AC-2** ...", "### D-3 ...". The first definition wins.
 *
 * A table row whose first cell is exactly an id defines it too, its text the
 * row's other non-empty cells joined by "; ":
 *
 *   | ID | Requirement | Check |
 *   |----|-------------|-------|
 *   | **R-1** | Totals are in the shopper's currency. | unit test |
 *
 * An id is a plain kind and number. `AC-3a`, `AC-AQR-1` and `INV-2` are not
 * read (AC-3a is not AC-3); criterionIdProblems lists them, and the ids a body
 * defines more than once, so an import can say what it could not read.
 */
export type RequirementKind = 'requirement' | 'acceptance' | 'decision' | 'invariant';
export interface RequirementRef { id: string; kind: RequirementKind; line: number; text: string }

const KIND: Record<string, RequirementKind> = { R: 'requirement', AC: 'acceptance', D: 'decision', I: 'invariant' };
const DEF = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)?(?:\*\*|__)?\s*(R|AC|D|I)-(\d+)(?![A-Za-z0-9])\s*(?:\*\*|__)?\s*[:.)—–-]?\s*(.*)$/;

const TABLE_ID = /^(?:\*\*|__)?\s*(R|AC|D|I)-(\d+)\s*(?:\*\*|__)?$/;

/** The cells of a GFM table row, outer pipes dropped, `\|` kept as a literal pipe. Null for a line that is not a row. */
function tableCells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  const cells = t.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
  return cells.length >= 2 ? cells : null;
}

/** The id a table row defines (first cell exactly an id), with its text; null otherwise. */
export function tableRowId(line: string): { kind: string; n: number; text: string } | null {
  const cells = tableCells(line);
  const m = cells ? TABLE_ID.exec(cells[0]!) : null;
  if (!cells || !m) return null;
  const text = cells.slice(1).map((c) => c.replace(/\*\*|__/g, '').trim()).filter(Boolean).join('; ');
  return { kind: m[1]!, n: Number(m[2]), text };
}

export function requirementIds(body: string): RequirementRef[] {
  const out: RequirementRef[] = [];
  const seen = new Set<string>();
  let fenced = false;
  body.split('\n').forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; return; }
    if (fenced) return;
    const row = tableRowId(raw);
    if (row) {
      const id = `${row.kind}-${row.n}`;
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ id, kind: KIND[row.kind]!, line: i + 1, text: row.text });
      return;
    }
    const m = DEF.exec(raw);
    if (!m) return;
    const id = `${m[1]}-${Number(m[2])}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, kind: KIND[m[1]!]!, line: i + 1, text: m[3]!.replace(/\*\*|__/g, '').trim() });
  });
  return out;
}

/**
 * The criteria a governed outcome is verified against (V1): the requirements
 * (R-n) and acceptance criteria (AC-n). Decisions and invariants are context.
 */
export function specCriteria(body: string): RequirementRef[] {
  return requirementIds(body).filter((r) => r.kind === 'requirement' || r.kind === 'acceptance');
}

/**
 * At a definition position (as DEF reads one), a token shaped like a criterion
 * id that is not a plain one: a letter suffix (AC-3a), a prefix (AC-AQR-1,
 * R-CG-4) or the INV kind (INV-2).
 */
const LOOSE_DEF = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)?(?:\*\*|__)?\s*((?:R|AC|D|I|INV)(?:-[A-Za-z][A-Za-z0-9]*)*-\d+[A-Za-z0-9]*)(?![A-Za-z0-9-])/;
const LOOSE_TABLE_ID = /^(?:\*\*|__)?\s*((?:R|AC|D|I|INV)(?:-[A-Za-z][A-Za-z0-9]*)*-\d+[A-Za-z0-9]*)\s*(?:\*\*|__)?$/;
const PLAIN_ID = /^(R|AC|D|I)-\d+$/;

export interface CriterionIdProblems {
  /** Criterion-like ids the parser does not read, where they are defined. */
  unreadable: Array<{ id: string; line: number }>;
  /** Ids defined more than once (only the first is read), with every defining line. */
  duplicates: Array<{ id: string; lines: number[] }>;
}

/** What a body's criterion ids would lose a reader: the ones not read, and the repeats. */
export function criterionIdProblems(body: string): CriterionIdProblems {
  const unreadable: CriterionIdProblems['unreadable'] = [];
  const defs = new Map<string, number[]>();
  let fenced = false;
  body.split('\n').forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; return; }
    if (fenced) return;
    const line = i + 1;
    const row = tableRowId(raw);
    const m = row ? null : DEF.exec(raw);
    const id = row ? `${row.kind}-${row.n}` : m ? `${m[1]}-${Number(m[2])}` : null;
    if (id) { defs.set(id, [...(defs.get(id) ?? []), line]); return; }
    const cells = tableCells(raw);
    const loose = cells ? LOOSE_TABLE_ID.exec(cells[0]!)?.[1] : LOOSE_DEF.exec(raw)?.[1];
    if (loose && !PLAIN_ID.test(loose)) unreadable.push({ id: loose, line });
  });
  const duplicates = [...defs].filter(([, lines]) => lines.length > 1).map(([id, lines]) => ({ id, lines }));
  return { unreadable, duplicates };
}

/** How many criteria could not be read: each unread id and each repeat definition. */
export function criteriaUnreadCount(c: CriterionIdProblems | null | undefined): number {
  if (!c) return 0;
  return c.unreadable.length + c.duplicates.reduce((k, d) => k + Math.max(0, d.lines.length - 1), 0);
}

/**
 * The criteria an import could not read, in words: "N criteria could not be
 * read; not read: AC-3a (line 4); defined more than once, ...". Empty when
 * there are none.
 */
export function criteriaUnreadText(c: CriterionIdProblems | null | undefined): string {
  const n = criteriaUnreadCount(c);
  if (!c || !n) return '';
  const parts = [
    ...(c.unreadable.length ? [`not read: ${c.unreadable.map((u) => `${u.id} (line ${u.line})`).join(', ')}`] : []),
    ...(c.duplicates.length ? [`defined more than once, only the first is read: ${c.duplicates.map((d) => `${d.id} (lines ${d.lines.join(', ')})`).join(', ')}`] : []),
  ];
  return `${n} ${n === 1 ? 'criterion' : 'criteria'} could not be read; ${parts.join('; ')}. Use plain ids (R-n, AC-n), each defined once.`;
}
