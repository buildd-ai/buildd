/**
 * The disjoint-delta landing rule (docs/specs/workflow-state-kernel.md §16 S15),
 * as pure functions shared by the kernel's reducer and the legacy landing door
 * (pr-landing.ts `evaluateTreadmillBound`).
 *
 * A PR behind its base was approved and went green on a tree that is not the
 * one a merge produces. That proves nothing about the merged tree in general
 * (#2611), which is why "behind" is normally a refresh. It does prove enough
 * when what the base gained since is small, readable, touches none of the
 * PR's files and none of the paths where "unrelated" is not a safe assumption:
 * then the merged tree differs from the tested one only in files the PR never
 * touched. On a base that moves faster than one CI cycle, that rule is what
 * lets the refresh treadmill end in a merge instead of in a page.
 *
 * No I/O: the base delta is read by the seam / door and arrives as a fact.
 */
import { isGeneratedMigrationPath } from '../migration-safety';

/**
 * Once a refresh cycle is spent, a head may land across a base gap of up to
 * this many commits (still only a disjoint, risk-free one). Below it, the
 * ordinary bound (`treadmillMaxBaseCommits`, default 3) applies, and only to a
 * head the platform's own refresh produced.
 */
export const TREADMILL_EXHAUSTED_MAX_BASE_COMMITS = 20;

/** The ordinary bound's public default; the live value is `policyValue('treadmillMaxBaseCommits')`. */
export const DEFAULT_TREADMILL_MAX_BASE_COMMITS = 3;

const LOCKFILE = /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.lock$/;
const PACKAGE_MANIFEST = /(^|\/)package\.json$/;
const SCHEMA_FILE = 'packages/core/db/schema.ts';
const CI_WORKFLOW = /^\.github\/workflows\//;
/** Repo-wide invariant tests: they read the whole tree, so a base change to one can fail on the PR's files. */
const REPO_INVARIANT_TEST = /^scripts\/[^/]+\.test\.ts$/;

/**
 * Paths where a base change is never "unrelated" to a PR, whatever files the
 * PR touches: migrations and the schema (ordering and drift), lockfiles and
 * package manifests (the whole build resolves through them), CI workflows
 * (they decide what "green" means) and repo-wide invariant tests.
 */
export function isRiskyLandingPath(path: string): boolean {
  return isGeneratedMigrationPath(path)
    || path === SCHEMA_FILE
    || LOCKFILE.test(path)
    || PACKAGE_MANIFEST.test(path)
    || CI_WORKFLOW.test(path)
    || REPO_INVARIANT_TEST.test(path);
}

/**
 * What the base gained since the head's merge-base, read live by the door:
 *  - `baseCommits`: commits on the base the head does not contain (compare
 *    `head...base` `ahead_by`); null = unreadable.
 *  - `baseFiles`: the files those commits changed; null = unlistable.
 *  - `prFiles`: the files the PR changes; null = unlistable.
 *  - `requiresUpToDate`: GitHub itself reports `mergeable_state: behind`, i.e.
 *    branch protection requires an up-to-date branch. A merge would be refused,
 *    so nothing tolerates it: the branch is refreshed.
 */
export interface BaseDeltaFact {
  baseCommits: number | null;
  baseFiles: string[] | null;
  prFiles: string[] | null;
  requiresUpToDate?: boolean;
}

export type BaseDeltaCause = 'refresh_unsafe' | 'refresh_exhausted';

export type BaseDeltaVerdict =
  | { tolerated: true; baseCommits: number; baseFileCount: number }
  /**
   * `refresh_unsafe`: the gap itself is the problem (a shared file, a risky
   * path; `files` names them), whatever its size. `refresh_exhausted`: the gap
   * is too big, unreadable, or the base requires an up-to-date branch.
   */
  | { tolerated: false; cause: BaseDeltaCause; reason: string; files?: string[] };

/** The disjoint-delta rule over one base-delta fact and a commit bound. */
export function judgeBaseDelta(fact: BaseDeltaFact, maxBaseCommits: number): BaseDeltaVerdict {
  if (fact.requiresUpToDate) {
    return { tolerated: false, cause: 'refresh_exhausted', reason: 'branch protection requires an up-to-date branch' };
  }
  if (fact.baseCommits == null) {
    return { tolerated: false, cause: 'refresh_exhausted', reason: 'could not count the commits the base gained' };
  }
  if (fact.baseCommits > maxBaseCommits) {
    return { tolerated: false, cause: 'refresh_exhausted', reason: `the base gained ${fact.baseCommits} commits since this head (limit ${maxBaseCommits})` };
  }
  if (!fact.baseFiles || !fact.prFiles) {
    return { tolerated: false, cause: 'refresh_exhausted', reason: 'could not list the files on one side of the gap' };
  }
  const risky = [...new Set([...fact.baseFiles, ...fact.prFiles].filter(isRiskyLandingPath))].sort();
  if (risky.length) {
    return { tolerated: false, cause: 'refresh_unsafe', reason: `the gap involves a migration, schema, lockfile, manifest, CI workflow or repo-wide test (${risky.join(', ')})`, files: risky };
  }
  const mine = new Set(fact.prFiles);
  const overlap = [...new Set(fact.baseFiles.filter((f) => mine.has(f)))].sort();
  if (overlap.length) {
    return { tolerated: false, cause: 'refresh_unsafe', reason: `the base changed files this PR changes (${overlap.join(', ')})`, files: overlap };
  }
  return { tolerated: true, baseCommits: fact.baseCommits, baseFileCount: fact.baseFiles.length };
}
