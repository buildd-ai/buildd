/**
 * A building task cannot change an acceptance test (Living Specs R-80, AC-126).
 *
 * When the PR of a building task edits or deletes an acceptance test, that is
 * flagged to a person, and no test result counts toward the task's outcome
 * until a person accepts the change. Results are recorded per criterion, not
 * per test file, so the hold covers every test-source verdict of the task;
 * reviews keep counting.
 *
 * Pure: the host reads the PR's file list, stores the flag (task context
 * `acceptanceEdit`) and passes it in.
 */

export interface AcceptanceEditFlag {
  /** Acceptance test paths the PR edits or deletes at `headSha`. */
  paths: string[];
  headSha: string;
  flaggedAt: string;
  /** Paths a person has accepted. */
  acceptedPaths: string[];
  acceptedBy?: string;
  acceptedAt?: string;
}

const ACCEPTANCE_FILE = /(^|\/)[^/]*acceptance[^/]*\.test\.[cm]?[jt]sx?$/i;
const ACCEPTANCE_DIR = /(^|\/)acceptance\/.*\.test\.[cm]?[jt]sx?$/i;

/** An acceptance test is a test file named for acceptance, or one under an `acceptance/` directory. */
export const isAcceptanceTestPath = (path: string): boolean => ACCEPTANCE_FILE.test(path) || ACCEPTANCE_DIR.test(path);

/** The acceptance tests among the paths a PR changes (a deletion and both sides of a rename are in the list). */
export const acceptanceTestPaths = (changed: readonly string[]): string[] => [...new Set(changed.filter(isAcceptanceTestPath))];

/** The flag after a PR sync: what was accepted stays accepted; no acceptance edit left means no flag. */
export function flagAcceptanceEdit(prev: AcceptanceEditFlag | null, paths: readonly string[], headSha: string, now: string): AcceptanceEditFlag | null {
  if (!paths.length) return null;
  const accepted = (prev?.acceptedPaths ?? []).filter((p) => paths.includes(p));
  return { paths: [...paths], headSha, flaggedAt: prev?.flaggedAt ?? now, acceptedPaths: accepted, ...(prev?.acceptedBy ? { acceptedBy: prev.acceptedBy, acceptedAt: prev.acceptedAt } : {}) };
}

/** A person's acceptance of everything flagged so far. */
export const acceptEdits = (flag: AcceptanceEditFlag, by: string, now: string): AcceptanceEditFlag =>
  ({ ...flag, acceptedPaths: [...flag.paths], acceptedBy: by, acceptedAt: now });

export const pendingAcceptance = (flag: AcceptanceEditFlag | null | undefined): string[] =>
  flag ? flag.paths.filter((p) => !flag.acceptedPaths.includes(p)) : [];

/** Read the flag from a task's context blob; anything malformed is no flag. */
export function acceptanceEditOf(context: unknown): AcceptanceEditFlag | null {
  const f = context && typeof context === 'object' ? (context as Record<string, unknown>).acceptanceEdit : null;
  if (!f || typeof f !== 'object') return null;
  const o = f as Record<string, unknown>;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  if (typeof o.headSha !== 'string') return null;
  return {
    paths: strs(o.paths), headSha: o.headSha, flaggedAt: typeof o.flaggedAt === 'string' ? o.flaggedAt : '', acceptedPaths: strs(o.acceptedPaths),
    ...(typeof o.acceptedBy === 'string' ? { acceptedBy: o.acceptedBy } : {}), ...(typeof o.acceptedAt === 'string' ? { acceptedAt: o.acceptedAt } : {}),
  };
}

/** Verdict rows without the test results, while an acceptance edit awaits a person. */
export function dropUnacceptedTestResults<T extends { source: string }>(rows: readonly T[], flag: AcceptanceEditFlag | null | undefined): T[] {
  return pendingAcceptance(flag).length ? rows.filter((r) => r.source !== 'test') : [...rows];
}
