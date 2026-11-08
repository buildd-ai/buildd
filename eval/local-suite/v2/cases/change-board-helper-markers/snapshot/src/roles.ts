import type { BoardTaskInput } from './types';

export type DeliverableRole = 'final-verification' | 'criterion-check';

/** Mission-level checks carry a marker in their context. */
export function deliverableRole(t: BoardTaskInput): DeliverableRole | null {
  const c = t.context;
  if (!c) return null;
  if ('finalVerification' in c) return 'final-verification';
  if ('specCriterionCheck' in c) return 'criterion-check';
  return null;
}
