import type { ChangeLine } from '@buildd/spec-contract/criterion-review';

/**
 * The criteria a revision adds or changes against the one before it, in its
 * order: the scope a mission selecting that revision at create answers for by
 * default (Living Specs D-41: a mission moves the criteria it adds, not the
 * whole spec). Removed and only-moved criteria are not in it. Pure, so the
 * new-mission form shows the same list the server stores.
 */
export function changedCriteria(lines: readonly ChangeLine[]): Array<{ id: string; text: string }> {
  const out = new Map<string, string>();
  for (const l of lines) {
    if (l.kind === 'added-range') for (const i of l.items) out.set(i.id, i.text);
    else if (l.kind === 'added' || l.kind === 'changed' || l.kind === 'replacing') out.set(l.id, l.text);
  }
  return [...out].map(([id, text]) => ({ id, text }));
}
