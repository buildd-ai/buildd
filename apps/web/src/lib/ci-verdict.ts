/**
 * The one rule for "is CI green on this commit", shared by the landing door
 * (`evaluateAutoMergeSafety`) and the workflow kernel's GitHub reader
 * (`workflow/github-facts.ts`) so the two cannot drift.
 *
 * Fail closed, by allow-list:
 * - a check run passes only when it is `completed` with conclusion `success`,
 *   `neutral` or `skipped` (what branch protection accepts). Every other
 *   conclusion (`failure`, `timed_out`, `cancelled`, `startup_failure`,
 *   `action_required`, `stale`, missing) and every unfinished status
 *   (`queued`, `in_progress`, `waiting`, `requested`, `pending`) blocks.
 * - a commit status (the Statuses API: Jenkins, CircleCI, Buildkite, Vercel
 *   contexts) passes only when its state is `success`; `failure`, `error` and
 *   `pending` block.
 * - every page is read. A read that comes back short of GitHub's `total_count`
 *   is unknown, never green.
 *
 * Pure: the GitHub call is injected, so this module has no auth or DB import.
 */

/** Check-run conclusions that count as passing. Everything else blocks. */
export const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(['success', 'neutral', 'skipped']);

/** Conclusions that are a real red (worth a CI fix), as opposed to "not passing yet". */
export const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set(['failure', 'timed_out', 'startup_failure']);

export function isPassingCheckRun(r: { status?: string | null; conclusion?: string | null }): boolean {
  return r.status === 'completed' && PASSING_CONCLUSIONS.has(String(r.conclusion ?? ''));
}

export function isFailingCheckRun(r: { status?: string | null; conclusion?: string | null }): boolean {
  return r.status === 'completed' && FAILING_CONCLUSIONS.has(String(r.conclusion ?? ''));
}

/** A commit status passes only when it says `success`. */
export function isPassingStatus(s: { state?: string | null }): boolean {
  return s.state === 'success';
}

type Api = (installationId: number, path: string) => Promise<unknown>;

const PER_PAGE = 100;
/** 10 pages = 1000 runs. A commit with more is reported incomplete (blocks), not silently truncated. */
const MAX_PAGES = 10;

export interface PagedRead<T> {
  items: T[];
  /** False when the read stopped short of GitHub's total_count (or hit MAX_PAGES): treat as unknown. */
  complete: boolean;
}

async function readPaged<T>(
  api: Api,
  installationId: number,
  basePath: string,
  key: string,
): Promise<PagedRead<T>> {
  const items: T[] = [];
  let total: number | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = basePath.includes('?') ? '&' : '?';
    const data = (await api(installationId, `${basePath}${sep}per_page=${PER_PAGE}&page=${page}`)) as Record<string, unknown> | null;
    const rows = data?.[key];
    if (!Array.isArray(rows)) throw new Error(`malformed GitHub response: no ${key} array`);
    if (typeof data?.total_count === 'number') total = data.total_count;
    items.push(...(rows as T[]));
    if (total !== null ? items.length >= total : rows.length < PER_PAGE) {
      return { items, complete: true };
    }
    if (rows.length === 0) break; // GitHub claims more but returned none: incomplete
  }
  return { items, complete: false };
}

/** Every check run on `sha`, all pages. Throws on a failed or malformed read. */
export function listAllCheckRuns<T = Record<string, unknown>>(
  api: Api, installationId: number, repoFullName: string, sha: string,
): Promise<PagedRead<T>> {
  // filter=latest (GitHub's default) already returns only the most recent run
  // per check name; callers still dedupe with latestRunPerName as a backstop.
  return readPaged<T>(api, installationId, `/repos/${repoFullName}/commits/${sha}/check-runs?filter=latest`, 'check_runs');
}

/**
 * The combined status's per-context statuses on `sha`, all pages. GitHub
 * already reduces this to the latest status per context. Its top-level `state`
 * is ignored on purpose: it reads `pending` when there are no statuses at all,
 * which is the common case for Actions-only repos.
 */
export function listAllCommitStatuses<T extends { context?: string; state?: string } = { context?: string; state?: string }>(
  api: Api, installationId: number, repoFullName: string, sha: string,
): Promise<PagedRead<T>> {
  return readPaged<T>(api, installationId, `/repos/${repoFullName}/commits/${sha}/status`, 'statuses');
}
