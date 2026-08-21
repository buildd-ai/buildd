import { workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';

/**
 * Repo identity helpers.
 *
 * Two facts drive everything here:
 *
 *  1. `workspaces.repo` is stored inconsistently — some rows hold a bare
 *     `owner/name`, most hold `https://github.com/owner/name`. Matching a
 *     webhook's `repository.full_name` with `eq()` therefore misses most
 *     workspaces silently.
 *  2. GitHub PR numbers are unique per repo, NOT globally. Looking a worker up
 *     by `prNumber` alone picks an arbitrary row when two repos both have a PR
 *     with that number — which silently stamps merge state onto the wrong
 *     workspace's worker.
 */

/** Strips the GitHub host prefix in any form we've seen stored. */
export const GITHUB_HOST_PREFIX_RE =
  '^(https?://(www\\.)?github\\.com/|git@github\\.com:|ssh://git@github\\.com/)';

/** Strips a trailing `.git` and/or trailing slashes. */
export const GIT_SUFFIX_RE = '(\\.git)?/*$';

/**
 * Normalizes a repo column down to a bare lowercase `owner/name`, so all of
 * these match the same repo:
 *   owner/name · https://github.com/owner/name · git@github.com:owner/name.git
 *
 * Substring matching is deliberately not used: `%owner/name%` also matches
 * `owner/name-legacy`.
 */
export function normalizedRepoSql(col: AnyColumn | SQL): SQL {
  return sql`lower(regexp_replace(regexp_replace(coalesce(${col}, ''), ${GITHUB_HOST_PREFIX_RE}, ''), ${GIT_SUFFIX_RE}, ''))`;
}

/** Predicate: workspaces pointing at `repoFullName`, in any stored form. */
export function workspaceRepoMatches(repoFullName: string): SQL {
  return sql`${normalizedRepoSql(workspaces.repo)} = ${repoFullName.toLowerCase()}`;
}

/**
 * The canonical `workers.prUrl` value for a PR. Verified against production:
 * all 979 worker rows with a prNumber store exactly this shape, none null.
 */
export function prUrlFor(repoFullName: string, prNumber: number): string {
  return `https://github.com/${repoFullName}/pull/${prNumber}`;
}

/**
 * Predicate: the worker that owns this PR, scoped to the repo the event is
 * about. Always prefer this over a bare `eq(workers.prNumber, n)`.
 */
export function workerOwnsPr(repoFullName: string, prNumber: number) {
  return and(
    eq(workers.prNumber, prNumber),
    eq(workers.prUrl, prUrlFor(repoFullName, prNumber)),
  );
}

/** Same as `workerOwnsPr` when the caller already holds the PR's html_url. */
export function workerOwnsPrUrl(prUrl: string, prNumber: number) {
  return and(eq(workers.prNumber, prNumber), eq(workers.prUrl, prUrl));
}
