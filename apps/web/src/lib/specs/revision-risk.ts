import { criterionRecords, type CriterionRecord } from '@buildd/spec-contract/criterion-records';
import { diffLines } from './diff';

/**
 * How much judgement a waiting spec revision needs, read from its text alone.
 * No model, no history, no network: the same two bodies always give the same
 * answer, and the label only orders and groups the inbox. It never approves
 * anything; Approve stays a click pinned to the revision's content hash.
 *
 * A revision is `judgement` when any of these holds, and `low-risk` only when
 * none does:
 *   - it is a first revision (nothing approved to compare with);
 *   - a criterion (R-n or AC-n) was added, removed, or changed in its words,
 *     checks, screens, replaces list, kind or section;
 *   - a changed line mentions credentials, permissions or approval rules;
 *   - a changed line sits in a code fence or the front matter, or changes a
 *     fence or heading line, or names a criterion id.
 * When in doubt it says `judgement`: a false "needs judgement" costs a read, a
 * false "low-risk" hides a change.
 */
export type RevisionRiskLevel = 'judgement' | 'low-risk';

export interface RevisionRisk {
  level: RevisionRiskLevel;
  /** Plain-language reasons, at most MAX_REASONS, in a stable order; empty for low-risk. */
  reasons: string[];
}

export const MAX_REASONS = 3;

/** Words that make a changed line a credential, permission or approval-rule change. Deliberately broad. */
const SENSITIVE = /\b(?:credentials?|secrets?|passwords?|passphrases?|passkeys?|tokens?|api[ _-]?keys?|private[ _-]keys?|oauth|authn|authz|authenticat\w*|authoriz\w*|authoris\w*|permissions?|privileges?|roles?|access|approv\w*|approvers?|owners?|admins?|administrators?|sign[ -]?offs?|merge[ -]polic\w*|waive[sdr]?|waivers?|encrypt\w*|sudo)\b/i;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const CRITERION_ID = /\b(?:R|AC)-\d+\b/;

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function criterionReasons(from: string, to: string): string[] {
  const before = new Map(criterionRecords(from).map((r) => [r.id, r]));
  const after = new Map(criterionRecords(to).map((r) => [r.id, r]));
  const out: string[] = [];
  for (const [id, r] of after) {
    const old = before.get(id);
    if (!old) out.push(`Criterion ${id} was added`);
    else if (changed(old, r)) out.push(`Criterion ${id} changed`);
  }
  for (const id of before.keys()) if (!after.has(id)) out.push(`Criterion ${id} was removed`);
  return out;
}

function changed(a: CriterionRecord, b: CriterionRecord): boolean {
  return a.text !== b.text || a.kind !== b.kind || a.section !== b.section
    || !same(a.checks, b.checks) || !same(a.screens, b.screens) || !same(a.replaces, b.replaces);
}

/** Per line: is it inside a fence or front matter (or is it the fence line itself)? */
function protectedLines(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let fenced = false;
  let front = lines[0]?.trim() === '---';
  lines.forEach((l, i) => {
    if (front) {
      out.push(true);
      if (i > 0 && l.trim() === '---') front = false;
      return;
    }
    if (FENCE.test(l)) { fenced = !fenced; out.push(true); return; }
    out.push(fenced);
  });
  return out;
}

export function classifyRevisionRisk(from: string | null, to: string): RevisionRisk {
  if (from === null) return { level: 'judgement', reasons: ['First revision: nothing approved to compare with'] };
  if (from === to) return { level: 'low-risk', reasons: [] };

  const reasons = criterionReasons(from, to);

  const a = from.split('\n');
  const b = to.split('\n');
  const guardA = protectedLines(a);
  const guardB = protectedLines(b);
  let i = 0; let j = 0;
  let sensitive = false; let structural = false; let ids = false;
  for (const op of diffLines(a, b)) {
    if (op.op === ' ') { i++; j++; continue; }
    const guarded = op.op === '-' ? guardA[i++] : guardB[j++];
    if (!op.text.trim()) continue;
    if (SENSITIVE.test(op.text)) sensitive = true;
    if (guarded || HEADING.test(op.text)) structural = true;
    if (CRITERION_ID.test(op.text)) ids = true;
  }
  if (sensitive) reasons.push('Wording about credentials, permissions or approval changed');
  if (structural) reasons.push('A heading, code block or front matter changed');
  if (ids && !reasons.some((r) => r.startsWith('Criterion '))) reasons.push('A line naming a criterion changed');

  return reasons.length
    ? { level: 'judgement', reasons: reasons.slice(0, MAX_REASONS) }
    : { level: 'low-risk', reasons: [] };
}
