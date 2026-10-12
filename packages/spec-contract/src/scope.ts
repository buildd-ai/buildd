/**
 * The criteria one task answers for (`context.specSource.criteria`). A spec
 * is usually built in slices, so a task filed for one slice names the
 * requirements and acceptance criteria that slice delivers, and its outcome,
 * its review and its checks cover exactly those. A task that names none
 * answers for every criterion of the pinned revision.
 *
 * Pure: the filer's list is checked against the revision's own criteria
 * (./requirements.ts) wherever a pin is taken (./pin.ts, ./claim-pin.ts).
 */

export const MAX_SCOPED_CRITERIA = 50;
const CRITERION_ID = /^(R|AC)-(\d+)$/;

export type ScopeCheck = { ok: true; criteria: string[] | null } | { ok: false; error: string };

/**
 * Validate a filer's scope against the revision's criteria ids. `undefined`
 * means no scope (every criterion). Ids are normalized (`AC-03` -> `AC-3`) and
 * de-duplicated, in the filer's order.
 */
export function checkCriteriaScope(raw: unknown, revisionCriteria: readonly string[], revision: number): ScopeCheck {
  if (raw === undefined) return { ok: true, criteria: null };
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SCOPED_CRITERIA) {
    return { ok: false, error: `context.specSource.criteria must list 1 to ${MAX_SCOPED_CRITERIA} criterion ids (R-n or AC-n), or be left out to cover every criterion` };
  }
  const known = new Set(revisionCriteria);
  const out: string[] = [];
  const unknown: string[] = [];
  for (const v of raw) {
    const m = typeof v === 'string' ? CRITERION_ID.exec(v.trim()) : null;
    const id = m ? `${m[1]}-${Number(m[2])}` : null;
    if (!id || !known.has(id)) { unknown.push(String(v)); continue; }
    if (!out.includes(id)) out.push(id);
  }
  if (unknown.length > 0) {
    return { ok: false, error: `context.specSource.criteria names ${unknown.join(', ')}, not a criterion of approved revision ${revision}${known.size ? ` (it has ${[...known].join(', ')})` : ''}` };
  }
  return { ok: true, criteria: out };
}

/** The scope a pin carries, or null when it covers every criterion. */
export function scopeOf(pin: Record<string, unknown> | null | undefined): string[] | null {
  const c = pin?.criteria;
  return Array.isArray(c) && c.length > 0 && c.every((x) => typeof x === 'string') ? (c as string[]) : null;
}

/** The criteria a pin answers for, in the revision's order. */
export function inScope<T extends { id: string }>(pin: Record<string, unknown> | null | undefined, criteria: readonly T[]): T[] {
  const scope = scopeOf(pin);
  return scope ? criteria.filter((c) => scope.includes(c.id)) : [...criteria];
}
