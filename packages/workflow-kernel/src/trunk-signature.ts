/**
 * CI failure signatures for the trunk circuit breaker
 * (docs/specs/workflow-state-kernel.md §6.10), as the kernel reads them:
 * `ci:<entry>|<entry>`, sorted. An entry is a failing check, at test level when
 * the host read the check's failing tests:
 *  - `<check>::<test>`: one failing test of that check;
 *  - `<check>::?`: the check failed and its tests could not be read;
 *  - `<check>`: the check failed, and was read, with no tests in it (lint, a gate).
 * How a check name or test is normalised is the host's (`Trunk.signatureOf`);
 * these only compare signatures.
 *
 * A shared check name is not a shared failure: sharded test jobs share a name
 * once normalised, so a PR failing its own test in shard 1/3 is not explained
 * by the base failing another test in shard 1/3. A test-level entry matches
 * only the same test, and an unread one (`::?`) matches nothing.
 */

/** The placeholder signature of a failure whose failing checks could not be read. */
export const UNKNOWN_CI_SIGNATURE = 'ci_failed';

/** Separates a check from one of its failing tests inside an entry. */
export const TEST_SEPARATOR = '::';
/** The test part of an entry whose check failed with tests that could not be read. */
export const UNREAD_TESTS = '?';

export function signatureChecks(signature: string): string[] {
  return signature.startsWith('ci:') ? signature.slice(3).split('|').filter(Boolean) : [];
}

/** The check an entry belongs to. */
export function entryCheck(entry: string): string {
  const i = entry.indexOf(TEST_SEPARATOR);
  return i < 0 ? entry : entry.slice(0, i);
}

/** The distinct check names of a signature, without their tests: what a title names. */
export function signatureCheckNames(signature: string): string[] {
  return [...new Set(signatureChecks(signature).map(entryCheck))];
}

const unread = (entry: string) => entry.endsWith(`${TEST_SEPARATOR}${UNREAD_TESTS}`);

/**
 * Does the base's failure explain the PR's? Every entry failing on the PR also
 * fails on the base: the same test of the same check, or the same test-less
 * check. A PR check whose tests could not be read is never explained.
 */
export function trunkExplains(prSignature: string, baseSignature: string): boolean {
  const pr = signatureChecks(prSignature);
  const base = new Set(signatureChecks(baseSignature));
  return pr.length > 0 && pr.every((n) => !unread(n) && base.has(n));
}

/**
 * Has the base recovered from the incident? None of the incident's entries
 * fails on the base now. A check whose tests could not be read now still
 * counts as failing them (unknown is never recovered), and a test-less
 * incident check is still failing while that check fails at all.
 */
export function trunkRecoveredFrom(incidentSignature: string, baseSignature: string): boolean {
  const now = signatureChecks(baseSignature);
  const exact = new Set(now);
  const failingChecks = new Set(now.map(entryCheck));
  const unreadChecks = new Set(now.filter(unread).map(entryCheck));
  return !signatureChecks(incidentSignature).some((n) => {
    if (exact.has(n)) return true;
    const check = entryCheck(n);
    if (check === n) return failingChecks.has(check);
    return unreadChecks.has(check);
  });
}
