/**
 * §13.13 rule 3 (workflow-kernel-library.md §5): a repair (a review fix, a CI fix) is an
 * executable builder, whatever its owner was. Pure: the review and CI fix builders share it.
 */

/** The default builder role a repair runs as when its owner has none, or is coordination-only (rule 3). */
export const REPAIR_BUILDER_ROLE = 'builder';

/** An owner whose deliverable is action taken elsewhere: its description is no brief for a code fix. */
export function isCoordinationOwner(owner: { kind?: string | null; category?: string | null }): boolean {
  return owner.kind === 'coordination' || owner.category === 'bookkeeping';
}

