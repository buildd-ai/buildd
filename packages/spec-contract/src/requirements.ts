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
 */
export type RequirementKind = 'requirement' | 'acceptance' | 'decision' | 'invariant';
export interface RequirementRef { id: string; kind: RequirementKind; line: number; text: string }

const KIND: Record<string, RequirementKind> = { R: 'requirement', AC: 'acceptance', D: 'decision', I: 'invariant' };
const DEF = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)?(?:\*\*|__)?\s*(R|AC|D|I)-(\d+)\s*(?:\*\*|__)?\s*[:.)—–-]?\s*(.*)$/;

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
