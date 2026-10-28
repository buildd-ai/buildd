import { criterionIdProblems, tableRowId } from './requirements';
import { sectionPaths } from './criterion-records';
import { contentHash } from './hash';

/**
 * `check:no-criteria-change` (Living Spec b7fc9316 R-21, R-22, R-27): whether
 * a revision changes nothing a person approved, so it can stand approved
 * without asking them again.
 *
 * What a person approves is the criteria and the design they are built to.
 * This compares exactly those, as text, between the approved revision and the
 * new one, and nothing else:
 *
 * - Every criterion line: each R-n, AC-n, D-n and I-n definition, the lines
 *   under it up to a blank line, and its `check:`, `screen:`, `verify:` and
 *   `replaces:` lines (which belong to it until the next id or heading, as the
 *   check-line parser reads them). Raw lines: whitespace counts, so the check
 *   never judges wording.
 * - Where each sits: its heading path and its order among the criteria. A
 *   moved criterion is a changed one.
 * - The design binding: the pinned design (kind, ref, version, screens) and
 *   each binding attachment at its pinned file revision.
 *
 * Context, other headings, out-of-scope text, open questions, reference
 * attachments and the change summary may change. Any doubt (an id defined
 * twice, a criterion-shaped id the parser cannot read, no criteria at all)
 * answers "changed": the revision then waits on a person, as before.
 *
 * Pure and offline: no model, no network, nothing an agent sends. The host
 * runs it on the server when a revision is written.
 */

export const NO_CRITERIA_CHANGE_CHECK = 'check:no-criteria-change';

/** One criterion as the check compares it: its id, its heading path and its raw lines. */
export interface CriterionBlock { id: string; section: string; lines: string[] }

/** A binding attachment at the file revision it is pinned to. */
export interface BindingPin { name: string; artifactId: string; revision: number }

export interface NoCriteriaChangeSide {
  body: string;
  /** The revision's pinned design; null when none. */
  design: unknown;
  bindings: readonly BindingPin[];
}

/** What the approval records: the hashes on each side, equal by construction. */
export interface NoCriteriaChangeEvidence {
  from: { criteriaHash: string; designHash: string };
  to: { criteriaHash: string; designHash: string };
  /** How many criterion blocks were compared. */
  criteria: number;
}

export type NoCriteriaChangeResult =
  | { unchanged: true; evidence: NoCriteriaChangeEvidence }
  | { unchanged: false; reason: 'criteria'; ids: string[]; message: string }
  | { unchanged: false; reason: 'design' | 'doubt'; message: string };

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const DEF = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)?(?:\*\*|__)?\s*(R|AC|D|I)-(\d+)(?![A-Za-z0-9])/;
const LABEL = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?(?:check|screens?|verify|replaces)(?:\*\*|__)?\s*:/i;

/**
 * Every criterion of a body, in body order, with the lines that are its own.
 * `doubt` says why the body cannot be compared safely; null when it can.
 */
export function criterionBlocks(body: string): { blocks: CriterionBlock[]; doubt: string | null } {
  const lines = body.split('\n');
  const paths = sectionPaths(body);
  const blocks: CriterionBlock[] = [];
  let current: CriterionBlock | null = null;
  // The words run on until a blank line; label lines attach until the next id or heading.
  let words = false;
  let fenced = false;
  lines.forEach((raw, i) => {
    if (FENCE.test(raw)) { fenced = !fenced; current = null; return; }
    if (fenced) return;
    const row = tableRowId(raw);
    const def = row ? [raw, row.kind, String(row.n)] : DEF.exec(raw);
    if (def) {
      current = { id: `${def[1]}-${Number(def[2])}`, section: paths[i] ?? '', lines: [raw] };
      blocks.push(current);
      words = !row;
      return;
    }
    if (HEADING.test(raw)) { current = null; return; }
    if (!current) return;
    if (!raw.trim()) { words = false; return; }
    if (words || LABEL.test(raw)) (current as CriterionBlock).lines.push(raw);
  });

  const problems = criterionIdProblems(body);
  const doubt = problems.duplicates.length
    ? `${problems.duplicates.map((d) => d.id).join(', ')} defined more than once`
    : problems.unreadable.length
      ? `${problems.unreadable.map((u) => u.id).join(', ')} cannot be read as criteria`
      : blocks.length === 0 ? 'the spec has no criteria to compare' : null;
  return { blocks, doubt };
}

/** JSON with object keys sorted, so the same design reads the same whatever order it was written in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

const blockText = (b: CriterionBlock) => `${b.section}\n${b.lines.join('\n')}`;
const designText = (s: NoCriteriaChangeSide) => canonical({
  design: s.design ?? null,
  bindings: [...s.bindings].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ name: p.name, artifactId: p.artifactId, revision: p.revision })),
});

/**
 * The ids that kept their order: a longest common subsequence of the two
 * orders (the same ids on both sides). An id outside it moved.
 */
function inOrder(x: readonly string[], y: readonly string[]): Set<string> {
  const w = y.length + 1;
  const L = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) L[i * w + j] = x[i] === y[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
  }
  const out = new Set<string>();
  let i = 0; let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.add(x[i]!); i++; j++; }
    else if (L[(i + 1) * w + j]! >= L[i * w + j + 1]!) i++;
    else j++;
  }
  return out;
}

/** Compare the approved revision (`from`) with a new one (`to`). */
export async function noCriteriaChange(from: NoCriteriaChangeSide, to: NoCriteriaChangeSide): Promise<NoCriteriaChangeResult> {
  const a = criterionBlocks(from.body);
  const b = criterionBlocks(to.body);
  const doubt = b.doubt ?? a.doubt;
  if (doubt) return { unchanged: false, reason: 'doubt', message: `Not compared: ${doubt}.` };

  // Each id's block on each side, and whether it kept its order among the
  // others; a difference in either is a change.
  const before = new Map(a.blocks.map((x) => [x.id, blockText(x)]));
  const after = new Map(b.blocks.map((x) => [x.id, blockText(x)]));
  const kept = inOrder(a.blocks.map((x) => x.id).filter((id) => after.has(id)), b.blocks.map((x) => x.id).filter((id) => before.has(id)));
  const ids: string[] = [];
  for (const [id, text] of after) if (before.get(id) !== text || (before.has(id) && !kept.has(id))) ids.push(id);
  for (const id of before.keys()) if (!after.has(id)) ids.push(id);
  if (ids.length) return { unchanged: false, reason: 'criteria', ids, message: `${ids.join(', ')} changed, moved, or were added or removed.` };

  const [da, db] = [designText(from), designText(to)];
  if (da !== db) return { unchanged: false, reason: 'design', message: 'The design or a binding attachment changed.' };

  // Each side hashed from its own text: the record shows they are equal, it does not assume it.
  const criteriaText = (x: CriterionBlock[]) => x.map(blockText).join('\n\u0000\n');
  const [ca, cb, ha, hb] = await Promise.all([contentHash(criteriaText(a.blocks)), contentHash(criteriaText(b.blocks)), contentHash(da), contentHash(db)]);
  return { unchanged: true, evidence: { from: { criteriaHash: ca, designHash: ha }, to: { criteriaHash: cb, designHash: hb }, criteria: b.blocks.length } };
}
