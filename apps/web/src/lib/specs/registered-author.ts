import type { RegisteredBinding } from '@buildd/spec-contract/verification-bindings';

export type RegisteredMethod = 'deterministic' | 'model' | 'fallback';

/**
 * The author a registered `verify:` row must carry: always a review
 * (`registered:<binding>`), whatever its method, which the row records
 * separately in `evidence.method`. A registered result is never a test result
 * (spec "Registered requirement verification" R-9). Rows written before this
 * carried `check:registered:` for deterministic runs; they stay readable, and
 * no recorder accepts that author for a new row. Both recorders enforce it.
 */
export function registeredAuthor(bindingId: RegisteredBinding['id'], _method: RegisteredMethod): string {
  return `registered:${bindingId}`;
}
