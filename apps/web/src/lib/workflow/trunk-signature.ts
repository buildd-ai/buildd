/**
 * CI failure signatures for the trunk circuit breaker
 * (docs/specs/workflow-state-kernel.md §6.10). Pure and dependency-light, so
 * the activity renderer can name the failing checks without loading the db.
 *
 * Comparing signatures is the package's (`@buildd/workflow-kernel/trunk-signature`);
 * how a check name normalises (`ciSignature`) is buildd's, and is what the
 * kernel's `Trunk.signatureOf` port answers with.
 */
import { normalizeErrorSignature } from '@buildd/core/error-signature';
import { UNKNOWN_CI_SIGNATURE, trunkRecoveredFrom } from '@buildd/workflow-kernel/trunk-signature';

export { UNKNOWN_CI_SIGNATURE, signatureChecks, trunkExplains } from '@buildd/workflow-kernel/trunk-signature';

/** `ci:<check>|<check>`: the sorted, normalised names of the failing checks. */
export function ciSignature(failing: string[]): string {
  const names = [...new Set(failing.map((n) => normalizeErrorSignature(n).toLowerCase()).filter(Boolean))].sort();
  return names.length ? `ci:${names.join('|')}` : UNKNOWN_CI_SIGNATURE;
}

/** Has the base recovered from the incident? None of the incident's checks fails on it any more. */
export function trunkRecovered(incidentSignature: string, baseFailing: string[]): boolean {
  return trunkRecoveredFrom(incidentSignature, ciSignature(baseFailing));
}
