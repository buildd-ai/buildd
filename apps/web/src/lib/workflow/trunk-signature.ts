/**
 * CI failure signatures for the trunk circuit breaker
 * (docs/specs/workflow-state-kernel.md §6.10). Pure and dependency-light, so
 * the activity renderer can name the failing checks without loading the db.
 */
import { normalizeErrorSignature } from '@buildd/core/error-signature';

/** The placeholder signature of a failure whose failing checks could not be read. */
export const UNKNOWN_CI_SIGNATURE = 'ci_failed';

/** `ci:<check>|<check>`: the sorted, normalised names of the failing checks. */
export function ciSignature(failing: string[]): string {
  const names = [...new Set(failing.map((n) => normalizeErrorSignature(n).toLowerCase()).filter(Boolean))].sort();
  return names.length ? `ci:${names.join('|')}` : UNKNOWN_CI_SIGNATURE;
}

export function signatureChecks(signature: string): string[] {
  return signature.startsWith('ci:') ? signature.slice(3).split('|').filter(Boolean) : [];
}

/** Does the base's failure explain the PR's? Every check failing on the PR also fails on the base. */
export function trunkExplains(prSignature: string, baseSignature: string): boolean {
  const pr = signatureChecks(prSignature);
  const base = new Set(signatureChecks(baseSignature));
  return pr.length > 0 && pr.every((n) => base.has(n));
}

/** Has the base recovered from the incident? None of the incident's checks fails on it any more. */
export function trunkRecovered(incidentSignature: string, baseFailing: string[]): boolean {
  const now = new Set(signatureChecks(ciSignature(baseFailing)));
  return !signatureChecks(incidentSignature).some((n) => now.has(n));
}

