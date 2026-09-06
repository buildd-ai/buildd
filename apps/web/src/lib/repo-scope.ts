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
 * The canonical `workers.prUrl` value for a PR.
 *
 * Checked against live data when this was written: every worker row carrying a
 * `prNumber` stored exactly this shape, with no nulls. Stated qualitatively on
 * purpose — this repo is public, and a row count is production data.
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

/**
 * JS-side counterpart to `normalizedRepoSql`, for building GitHub API paths.
 *
 * Separate from the SQL version on purpose, with two differences that matter:
 *
 *  - It preserves case. The SQL predicate lowercases because it only ever
 *    compares; an API path is fine either way, but the value also ends up in
 *    log lines and prUrls, where the owner's real casing is worth keeping.
 *  - It returns `null` rather than a mangled string for anything that is not
 *    exactly `owner/name`. `/repos/${repo}/pulls/N` with a bad `repo` does not
 *    error — it silently becomes a different, plausible-looking endpoint that
 *    404s. Refusing to build the path at all is the only safe failure.
 */
export function normalizeRepoFullName(repo: string | null | undefined): string | null {
  const stripped = (repo ?? '')
    .trim()
    .replace(new RegExp(GITHUB_HOST_PREFIX_RE), '')
    .replace(new RegExp(GIT_SUFFIX_RE), '');
  // Exactly two non-empty segments, no path characters that could escape the
  // API path. GitHub's own charset for owners/repos is a subset of this.
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(stripped) ? stripped : null;
}

/**
 * The repo a PR actually lives in, read off the worker's own `prUrl`.
 *
 * This is the authoritative source, and `workspaces.repo` is not: a worker
 * routinely opens its PR in a repo other than the one its workspace points at
 * (a sibling mobile repo, an umbrella repo), and coordination workspaces have
 * no repo at all while still owning workers with real PRs.
 *
 * Requires a numeric PR segment, so a `pull/new/<branch>` compare URL — what a
 * worker stores when it prepared a PR but never opened one — is rejected
 * rather than mistaken for a PR.
 */
export function repoFullNameFromPrUrl(prUrl: string | null | undefined): string | null {
  const match = (prUrl ?? '').match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/);
  return match ? normalizeRepoFullName(match[1]) : null;
}

/**
 * The repo to query for a worker's PR: its own prUrl first, the workspace's
 * repo only as a fallback. `null` means no GitHub call is possible.
 */
export function resolvePrRepo(worker: {
  prUrl: string | null | undefined;
  workspaceRepo: string | null | undefined;
}): string | null {
  return repoFullNameFromPrUrl(worker.prUrl) ?? normalizeRepoFullName(worker.workspaceRepo);
}
