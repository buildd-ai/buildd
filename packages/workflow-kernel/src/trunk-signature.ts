/**
 * CI failure signatures for the trunk circuit breaker
 * (docs/specs/workflow-state-kernel.md §6.10), as the kernel reads them:
 * `ci:<check>|<check>`, the sorted, normalised names of the failing checks.
 * How a check name is normalised is the host's (`Trunk.signatureOf`); these
 * only compare signatures.
 */

/** The placeholder signature of a failure whose failing checks could not be read. */
export const UNKNOWN_CI_SIGNATURE = 'ci_failed';

export function signatureChecks(signature: string): string[] {
  return signature.startsWith('ci:') ? signature.slice(3).split('|').filter(Boolean) : [];
}

/** Does the base's failure explain the PR's? Every check failing on the PR also fails on the base. */
export function trunkExplains(prSignature: string, baseSignature: string): boolean {
  const pr = signatureChecks(prSignature);
  const base = new Set(signatureChecks(baseSignature));
  return pr.length > 0 && pr.every((n) => base.has(n));
}

/** Has the base recovered from the incident? None of the incident's checks is in the base's signature now. */
export function trunkRecoveredFrom(incidentSignature: string, baseSignature: string): boolean {
  const now = new Set(signatureChecks(baseSignature));
  return !signatureChecks(incidentSignature).some((n) => now.has(n));
}
