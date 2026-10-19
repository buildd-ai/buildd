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
/**
 * A generated Drizzle migration; the same pattern as migration-safety.ts
 * `isGeneratedMigrationPath` (kept here so the kernel imports no module;
 * base-delta.test.ts pins the two together).
 */
const MIGRATION_PATH = /(?:^|\/)drizzle\/(?:\d{4}_[^/]+\.sql|\d{14}_[^/]+\/migration\.sql)$/;

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
 * A migration or the schema. Their risk is ordering and drift against the
 * PR's own migration or schema change, so on the base side of a gap they are
 * risky only when the PR side has one too (92a439a6).
 */
export function isSchemaLandingPath(path: string): boolean {
  return MIGRATION_PATH.test(path) || path === SCHEMA_FILE;
}

/**
 * Paths where a change is never "unrelated" to a PR: migrations and the
 * schema (ordering and drift; base-side only against the PR's own, see
 * `isSchemaLandingPath`), lockfiles and package manifests (the whole build
 * resolves through them), CI workflows (they decide what "green" means) and
 * repo-wide invariant tests. All but the first pair are risky on either side,
 * whatever files the PR touches.
 */
export function isRiskyLandingPath(path: string): boolean {
  return isSchemaLandingPath(path)
    || LOCKFILE.test(path)
    || PACKAGE_MANIFEST.test(path)
    || CI_WORKFLOW.test(path)
    || REPO_INVARIANT_TEST.test(path);
}

/** One changed line of a manifest diff that sets nothing but a `"version"` field. */
const VERSION_LINE = /^[+-][ \t]*"version"[ \t]*:[ \t]*"[^"]*"[ \t]*,?[ \t]*$/;

/**
 * Manifests in a compare `files` list whose diff changes only a `"version"`
 * field: a release bump (`chore: bump version to …`). Nothing resolves through
 * a package's own version, so such a manifest is not a risky path. Fails
 * closed: an added, removed or renamed manifest, a missing patch (GitHub omits
 * it on large diffs) or any other changed line (a dependency, a script) keeps
 * the manifest risky.
 */
export function versionBumpManifests(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  const out: string[] = [];
  for (const f of files as Array<{ filename?: unknown; status?: unknown; patch?: unknown }>) {
    if (typeof f?.filename !== 'string' || !PACKAGE_MANIFEST.test(f.filename)) continue;
    if (f.status !== undefined && f.status !== 'modified') continue;
    if (typeof f.patch !== 'string') continue;
    const changed = f.patch.split('\n').filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'));
    if (changed.length && changed.every((l) => VERSION_LINE.test(l))) out.push(f.filename);
  }
  return out;
}

/**
 * What the base gained since the head's merge-base, read live by the door:
 *  - `baseCommits`: commits on the base the head does not contain (compare
 *    `head...base` `ahead_by`); null = unreadable.
 *  - `baseFiles`: the files those commits changed; null = unlistable.
 *  - `prFiles`: the files the PR changes; null = unlistable.
 *  - `versionBumpFiles`: the base files whose gap diff changes only a
 *    manifest's `"version"` field (`versionBumpManifests`); not risky.
 *  - `requiresUpToDate`: GitHub itself reports `mergeable_state: behind`, i.e.
 *    branch protection requires an up-to-date branch. A merge would be refused,
 *    so nothing tolerates it: the branch is refreshed.
 */
export interface BaseDeltaFact {
  baseCommits: number | null;
  baseFiles: string[] | null;
  prFiles: string[] | null;
  versionBumpFiles?: string[];
  requiresUpToDate?: boolean;
}

export type BaseDeltaCause = 'refresh_unsafe' | 'refresh_exhausted';

export type BaseDeltaVerdict =
  | { tolerated: true; baseCommits: number; baseFileCount: number }
  /**
   * `refresh_unsafe`: the gap itself is the problem (a shared file, a risky
   * path; `files` names them), whatever its size. `refresh_exhausted`: the gap
   * is too big, unreadable, or the base requires an up-to-date branch.
   * `basis` (refresh_unsafe only) says which: `risky_path` (a path where
   * "unrelated" is unsafe; a base-side migration or schema change only when
   * the PR has one too) or `overlap` (the base changed
   * the PR's own files).
   */
  | { tolerated: false; cause: BaseDeltaCause; reason: string; files?: string[]; basis?: BaseDeltaBasis };

export type BaseDeltaBasis = 'risky_path' | 'overlap';

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
  const bumps = new Set(fact.versionBumpFiles ?? []);
  const prSchema = fact.prFiles.some(isSchemaLandingPath);
  const baseRisky = fact.baseFiles.filter((f) => !bumps.has(f) && isRiskyLandingPath(f) && (prSchema || !isSchemaLandingPath(f)));
  const risky = [...new Set([...baseRisky, ...fact.prFiles.filter(isRiskyLandingPath)])].sort();
  if (risky.length) {
    return { tolerated: false, cause: 'refresh_unsafe', basis: 'risky_path', reason: `the gap involves a migration, schema, lockfile, manifest, CI workflow or repo-wide test (${risky.join(', ')})`, files: risky };
  }
  const mine = new Set(fact.prFiles);
  const overlap = [...new Set(fact.baseFiles.filter((f) => mine.has(f)))].sort();
  if (overlap.length) {
    return { tolerated: false, cause: 'refresh_unsafe', basis: 'overlap', reason: `the base changed files this PR changes (${overlap.join(', ')})`, files: overlap };
  }
  return { tolerated: true, baseCommits: fact.baseCommits, baseFileCount: fact.baseFiles.length };
}
