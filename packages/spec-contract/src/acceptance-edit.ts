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

import type { StrictnessVerdict } from './acceptance-strictness';

/** Who accepted an edit when the deterministic strictness check did (spec R-80). */
export const STRICTNESS_CHECK_ID = 'check:acceptance-edit-strictness';

/** What the strictness check found for one path at one head; the evidence behind an automatic accept or a hold. */
export interface StrictnessCheck {
  path: string;
  verdict: StrictnessVerdict;
  headSha: string;
  autoAccepted: boolean;
  /** Plain sentences naming what got weaker (held edits). */
  weakened: string[];
  /** What got stricter (accepted edits). */
  stricter: string[];
  reason?: string;
}

export interface AcceptanceEditFlag {
  /** Acceptance test paths the PR edits or deletes at `headSha`. */
  paths: string[];
  headSha: string;
  flaggedAt: string;
  /** Paths a person has accepted. */
  acceptedPaths: string[];
  acceptedBy?: string;
  acceptedAt?: string;
  /** The strictness check's finding per path, latest head only. */
  checks?: StrictnessCheck[];
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
  const checks = (prev?.checks ?? []).filter((c) => paths.includes(c.path));
  return {
    paths: [...paths], headSha, flaggedAt: prev?.flaggedAt ?? now, acceptedPaths: accepted,
    ...(prev?.acceptedBy ? { acceptedBy: prev.acceptedBy, acceptedAt: prev.acceptedAt } : {}),
    ...(checks.length ? { checks } : {}),
  };
}

/** An automatic accept is only good for the head it was checked at: a new push is checked again. */
export function dropStaleAutoAccepts(flag: AcceptanceEditFlag | null, headSha: string): AcceptanceEditFlag | null {
  if (!flag) return null;
  const stale = new Set((flag.checks ?? []).filter((c) => c.autoAccepted && c.headSha !== headSha).map((c) => c.path));
  if (!stale.size) return flag;
  return { ...flag, acceptedPaths: flag.acceptedPaths.filter((p) => !stale.has(p)), checks: (flag.checks ?? []).filter((c) => !stale.has(c.path)) };
}

/**
 * Record the strictness check's findings: a stricter or equivalent path is
 * accepted by the check, anything else stays pending with what got weaker.
 * `acceptedBy` only names the check while no person has accepted anything.
 */
export function applyStrictnessChecks(flag: AcceptanceEditFlag, checks: readonly StrictnessCheck[], now: string): AcceptanceEditFlag {
  if (!checks.length) return flag;
  const byPath = new Map(checks.map((c) => [c.path, c]));
  const auto = checks.filter((c) => c.autoAccepted).map((c) => c.path);
  const person = flag.acceptedBy && flag.acceptedBy !== STRICTNESS_CHECK_ID;
  return {
    ...flag,
    acceptedPaths: [...new Set([...flag.acceptedPaths, ...auto])],
    checks: [...(flag.checks ?? []).filter((c) => !byPath.has(c.path)), ...checks],
    ...(auto.length && !person ? { acceptedBy: STRICTNESS_CHECK_ID, acceptedAt: now } : {}),
  };
}

/** Why a pending path is held, per the check: plain sentences, or one line when the file could not be read. */
export function heldReasons(flag: AcceptanceEditFlag | null | undefined, path: string): string[] {
  const c = flag?.checks?.find((x) => x.path === path && !x.autoAccepted);
  if (!c) return [];
  if (c.verdict === 'unparseable') return ["Could not read this file, so it was not checked."];
  return c.weakened;
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
  const checks = Array.isArray(o.checks) ? o.checks.flatMap((c): StrictnessCheck[] => {
    if (!c || typeof c !== 'object') return [];
    const r = c as Record<string, unknown>;
    if (typeof r.path !== 'string' || typeof r.headSha !== 'string' || typeof r.verdict !== 'string') return [];
    return [{ path: r.path, headSha: r.headSha, verdict: r.verdict as StrictnessVerdict, autoAccepted: r.autoAccepted === true, weakened: strs(r.weakened), stricter: strs(r.stricter), ...(typeof r.reason === 'string' ? { reason: r.reason } : {}) }];
  }) : [];
  return {
    ...(checks.length ? { checks } : {}),
    paths: strs(o.paths), headSha: o.headSha, flaggedAt: typeof o.flaggedAt === 'string' ? o.flaggedAt : '', acceptedPaths: strs(o.acceptedPaths),
    ...(typeof o.acceptedBy === 'string' ? { acceptedBy: o.acceptedBy } : {}), ...(typeof o.acceptedAt === 'string' ? { acceptedAt: o.acceptedAt } : {}),
  };
}

/** Verdict rows without the test results, while an acceptance edit awaits a person. */
export function dropUnacceptedTestResults<T extends { source: string }>(rows: readonly T[], flag: AcceptanceEditFlag | null | undefined): T[] {
  return pendingAcceptance(flag).length ? rows.filter((r) => r.source !== 'test') : [...rows];
}
