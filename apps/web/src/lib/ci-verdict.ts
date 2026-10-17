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

/**
 * Every check run on `sha`, all pages. Throws on a failed or malformed read.
 *
 * Each run that belongs to a GitHub Actions workflow run is annotated with the
 * `workflow_id` of that workflow (read from the commit's workflow runs, matched on
 * check suite), because a job name alone does not identify a check: `integration`
 * exists in several workflows. When the workflow-run read fails or is incomplete
 * (5xx, no actions:read, too many pages) the check runs are still returned, each given
 * its own workflow id, so nothing collapses and every failing run keeps counting: the
 * degraded read errs red, never green.
 */
export async function listAllCheckRuns<T = Record<string, unknown>>(
  api: Api, installationId: number, repoFullName: string, sha: string,
): Promise<PagedRead<T>> {
  // filter=latest (GitHub's default) already returns only the most recent run
  // per check name; callers still dedupe with latestRunPerName as a backstop.
  const read = await readPaged<T>(api, installationId, `/repos/${repoFullName}/commits/${sha}/check-runs?filter=latest`, 'check_runs');
  const inSuite = (r: T) => (r as { check_suite?: { id?: number | null } | null }).check_suite?.id;
  if (!read.items.some((r) => typeof inSuite(r) === 'number')) return read;
  const bySuite = new Map<number, number>();
  let wfRead = true;
  try {
    const wf = await readPaged<{ workflow_id?: number; check_suite_id?: number }>(
      api, installationId, `/repos/${repoFullName}/actions/runs?head_sha=${encodeURIComponent(sha)}`, 'workflow_runs',
    );
    if (!wf.complete) wfRead = false;
    for (const w of wf.items) {
      if (typeof w.check_suite_id === 'number' && typeof w.workflow_id === 'number') bySuite.set(w.check_suite_id, w.workflow_id);
    }
  } catch {
    wfRead = false;
  }
  const items = read.items.map((r, i) => {
    // Unknown workflows: a distinct negative id per run, so no run supersedes another.
    if (!wfRead) return { ...r, workflow_id: -(i + 1) };
    const suite = inSuite(r);
    const workflow_id = typeof suite === 'number' ? bySuite.get(suite) : undefined;
    return workflow_id === undefined ? r : { ...r, workflow_id };
  });
  return { items, complete: read.complete };
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

export interface CheckRunState {
  name: string;
  status: string;
  conclusion: string | null;
  /** GitHub check-run id; monotonically increasing, so a higher id is a later run. */
  id?: number;
  started_at?: string | null;
  /** When the run finished (ISO). The landing clock reads green from here. */
  completed_at?: string | null;
  /** The GitHub App that reported the run. Part of what makes two runs "the same check". */
  app?: { id?: number | null } | null;
  /**
   * The Actions workflow the run belongs to, annotated by listAllCheckRuns. A re-run or
   * re-triggered workflow keeps its workflow_id; a same-named job elsewhere does not.
   */
  workflow_id?: number | null;
}

/** A run's identity for supersession: (workflow, app, name), not the name alone. */
function runKey(r: CheckRunState): string {
  return `${r.workflow_id ?? ''}|${r.app?.id ?? ''}|${r.name}`;
}

function isNewer(a: CheckRunState, b: CheckRunState): boolean | null {
  if (typeof a.id === 'number' && typeof b.id === 'number') return a.id > b.id;
  if (a.started_at && b.started_at) return Date.parse(a.started_at) > Date.parse(b.started_at);
  return null;
}

/**
 * Collapse to the most recent run per check, a check being (workflow, app, name).
 * Job names such as `integration` repeat across workflows, so a newer pass in one
 * workflow must not hide an older failure of a same-named job in another. A re-run
 * or a re-triggered workflow (e.g. a PR-body edit) leaves the superseded run attached
 * to the same head SHA, and its stale failure must not outvote the run that replaced
 * it. Runs without workflow info (non-Actions apps, or unannotated input) match on
 * (app, name).
 *
 * Fails closed: two same-name runs with nothing to order them by are both
 * kept, so an unorderable failure still blocks.
 */
export function latestRunPerName<T extends CheckRunState>(checkRuns: T[]): T[] {
  const kept: T[] = [];
  for (const run of checkRuns) {
    const key = runKey(run);
    const i = kept.findIndex((k) => runKey(k) === key);
    if (i === -1) {
      kept.push(run);
      continue;
    }
    const newer = isNewer(run, kept[i]);
    if (newer === true) kept[i] = run;
    else if (newer === null) kept.push(run);
  }
  return kept;
}
