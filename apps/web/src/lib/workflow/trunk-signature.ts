/**
 * CI failure signatures for the trunk circuit breaker
 * (docs/specs/workflow-state-kernel.md §6.10). Pure and dependency-light, so
 * the activity renderer can name the failing checks without loading the db.
 *
 * Comparing signatures is the package's (`@buildd/workflow-kernel/trunk-signature`);
 * how a check name and a test name normalise (`ciSignature`) is buildd's, and is
 * what the kernel's `Trunk.signatureOf` port answers with.
 */
import { normalizeErrorSignature } from '@buildd/core/error-signature';
import { TEST_SEPARATOR, UNKNOWN_CI_SIGNATURE, UNREAD_TESTS, trunkRecoveredFrom } from '@buildd/workflow-kernel/trunk-signature';

export { UNKNOWN_CI_SIGNATURE, signatureCheckNames, signatureChecks, trunkExplains } from '@buildd/workflow-kernel/trunk-signature';

/** Failing tests kept per check; more collapse to `<check>::*`, which matches only another `<check>::*`. */
export const MAX_TESTS_PER_CHECK = 8;
/** Test names past this length are cut (the signature lives in a unique index). */
export const MAX_TEST_NAME = 100;
/** A signature longer than this collapses every check's tests to `<check>::*`. */
export const MAX_SIGNATURE_LENGTH = 2000;
const MANY_TESTS = '*';

// `|` separates entries, so it never survives inside one.
const norm = (s: string) => normalizeErrorSignature(s).toLowerCase().replace(/\|/g, '/');

function normEntry(entry: string): { check: string; test: string | null } | null {
  const i = entry.indexOf(TEST_SEPARATOR);
  const check = norm(i < 0 ? entry : entry.slice(0, i));
  if (!check) return null;
  if (i < 0) return { check, test: null };
  const raw = entry.slice(i + TEST_SEPARATOR.length).trim();
  const test = raw === UNREAD_TESTS || raw === MANY_TESTS ? raw : norm(raw).slice(0, MAX_TEST_NAME);
  return { check, test: test || UNREAD_TESTS };
}

/**
 * `ci:<entry>|<entry>`: the sorted, normalised failing entries. An entry is a
 * check name, or `<check>::<test>` at test level (`failing-tests.ts`). A check
 * read at test level never also stands bare.
 */
export function ciSignature(failing: string[]): string {
  const byCheck = new Map<string, Set<string>>();
  for (const e of failing) {
    const n = normEntry(e);
    if (!n) continue;
    const tests = byCheck.get(n.check) ?? new Set<string>();
    if (n.test) tests.add(n.test);
    byCheck.set(n.check, tests);
  }
  const build = (collapse: boolean) => {
    const entries: string[] = [];
    for (const [check, tests] of byCheck) {
      if (tests.size === 0) { entries.push(check); continue; }
      // An unread shard leaves the whole check unread: its tests are not all known.
      if (tests.has(UNREAD_TESTS)) { entries.push(`${check}${TEST_SEPARATOR}${UNREAD_TESTS}`); continue; }
      if (collapse || tests.has(MANY_TESTS) || tests.size > MAX_TESTS_PER_CHECK) { entries.push(`${check}${TEST_SEPARATOR}${MANY_TESTS}`); continue; }
      for (const t of tests) entries.push(`${check}${TEST_SEPARATOR}${t}`);
    }
    return entries.sort();
  };
  let entries = build(false);
  if (`ci:${entries.join('|')}`.length > MAX_SIGNATURE_LENGTH) entries = build(true);
  return entries.length ? `ci:${entries.join('|')}` : UNKNOWN_CI_SIGNATURE;
}

/** Has the base recovered from the incident? None of the incident's entries fails on it any more. */
export function trunkRecovered(incidentSignature: string, baseFailing: string[]): boolean {
  return trunkRecoveredFrom(incidentSignature, ciSignature(baseFailing));
}
