/**
 * What kind of spec this is (Living Spec b7fc9316 R-38). Only a `contract`
 * revision goes to the main approval inbox; the others are listed in a
 * separate "Other drafts" lane and never block a build or a merge. A kind only
 * groups and orders: it approves nothing (R-45).
 */
import { SPEC_KINDS, type SpecKind } from '@buildd/core/db/schema';

export { SPEC_KINDS, type SpecKind };
export const DEFAULT_SPEC_KIND: SpecKind = 'contract';

/** Why `kind` is not a spec kind, or null when it is. */
export function specKindRefusal(kind: unknown): string | null {
  return SPEC_KINDS.includes(kind as SpecKind) ? null : `kind must be one of: ${SPEC_KINDS.join(', ')}`;
}

/** Whether a revision of a spec of this kind belongs in the main inbox list. */
export const inMainInboxLane = (kind: SpecKind): boolean => kind === 'contract';
