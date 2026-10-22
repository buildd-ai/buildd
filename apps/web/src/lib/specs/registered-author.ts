import type { RegisteredBinding } from '@buildd/spec-contract/verification-bindings';

export type RegisteredMethod = 'deterministic' | 'model' | 'fallback';

/**
 * The author a registered `verify:` row must carry. Only a deterministic run of
 * the deterministic verifier is a test result (`check:`, outranks reviews);
 * a model judgment or a fallback is a review. Both recorders enforce it.
 */
export function registeredAuthor(bindingId: RegisteredBinding['id'], method: RegisteredMethod): string {
  return method === 'deterministic' && bindingId === 'ui.actions_match_state' ? `check:registered:${bindingId}` : `registered:${bindingId}`;
}
