// Server-side release operations backed by the GitHub App installation token.
// These are the "buildd performs git on the orchestrator's behalf" primitives:
// the caller (claude.ai, a worker, the UI) has no checkout, so buildd executes
// against the GitHub API. Pure strategy resolution lives in
// `@buildd/core/release-strategy`; this module is the I/O half.

import { githubApi } from '@/lib/github';

export interface DispatchResult {
  dispatched: boolean;
  workflowFile: string;
  ref: string;
  inputs: Record<string, string>;
  // Readback — populated when the run is found after dispatch (best-effort).
  runId?: number;
  runStatus?: string; // queued | in_progress | completed | ...
  runConclusion?: string | null; // success | failure | null (while running)
  runUrl?: string;
  // Fallback link to the workflow's runs list when the specific run isn't found yet.
  runsUrl: string;
}

// Dispatch a workflow_dispatch and read the resulting run back. `workflow_dispatch`
// returns 204 with no run id, so we poll the workflow's runs list for the newest
// run on this ref. Best-effort and bounded — if the run hasn't surfaced yet we
// return the runs URL so the caller can follow it.
export async function dispatchWorkflowRelease(
  installationId: number,
  owner: string,
  name: string,
  opts: { workflowFile: string; ref: string; inputs: Record<string, string> },
  poll: { attempts?: number; intervalMs?: number } = {},
): Promise<DispatchResult> {
  const { workflowFile, ref, inputs } = opts;
  const runsUrl = `https://github.com/${owner}/${name}/actions/workflows/${workflowFile}`;

  // Recorded before dispatch: the runs list below is the newest run on this
  // workflow+branch+event overall, which can be a run from weeks ago if ours
  // hasn't surfaced in the API yet. Only a run created at/after this point is
  // actually the one we just triggered.
  const dispatchedAt = Date.now();
  // Tolerance for clock skew between buildd and GitHub's own timestamps.
  const clockSkewToleranceMs = 15_000;

  await githubApi(installationId, `/repos/${owner}/${name}/actions/workflows/${workflowFile}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref, inputs }),
  });

  const attempts = poll.attempts ?? 6;
  const intervalMs = poll.intervalMs ?? 2_500;

  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const data = await githubApi(
        installationId,
        `/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(ref)}&per_page=5`,
      );
      const runs: Array<{ id: number; status: string; conclusion: string | null; html_url: string; created_at: string }> =
        data?.workflow_runs ?? [];
      const run = runs.find((r) => new Date(r.created_at).getTime() >= dispatchedAt - clockSkewToleranceMs);
      if (run) {
        return {
          dispatched: true,
          workflowFile,
          ref,
          inputs,
          runId: run.id,
          runStatus: run.status,
          runConclusion: run.conclusion,
          runUrl: run.html_url,
          runsUrl,
        };
      }
    } catch {
      // Transient — keep polling, then fall through to the runs URL.
    }
  }

  // No run created since our dispatch ever surfaced — report the runs list
  // link rather than a stale run, so the caller doesn't mistake an old
  // completed run for the one it just triggered.
  return { dispatched: true, workflowFile, ref, inputs, runsUrl };
}

export interface CheckRun {
  name: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | neutral | skipped | ...
}

// Classify a set of GitHub check-runs into a single CI state. Pure, so the
// branching (no runs → unknown, any incomplete → pending, else pass/fail) is
// unit-tested without hitting the network.
export function classifyCheckRuns(allRuns: CheckRun[]): {
  ciState: 'passing' | 'failing' | 'pending' | 'unknown';
  failingChecks: string[];
} {
  // Advisory checks never gate: see POST_MERGE_INTEGRATION_CHECK_PREFIX.
  const runs = allRuns.filter((r) => !isPostMergeIntegrationCheck(r.name));
  if (runs.length === 0) return { ciState: 'unknown', failingChecks: [] };
  if (runs.some((r) => r.status !== 'completed')) return { ciState: 'pending', failingChecks: [] };
  const failing = runs.filter((r) => r.conclusion && !['success', 'neutral', 'skipped'].includes(r.conclusion));
  return {
    ciState: failing.length > 0 ? 'failing' : 'passing',
    failingChecks: failing.map((r) => r.name),
  };
}

// `.github/workflows/post-merge-integration.yml` runs the API integration
// tests against every `dev` push, after merge. It is advisory by design: a
// release PR's head IS a dev SHA, so if its check counted here a flaky test
// machine would block every release. Its check-run name is
// "<caller job name> / <reusable job name>", hence a prefix match.
export const POST_MERGE_INTEGRATION_CHECK_PREFIX = 'post-merge integration';

export function isPostMergeIntegrationCheck(name: string): boolean {
  return name.toLowerCase().startsWith(POST_MERGE_INTEGRATION_CHECK_PREFIX);
}

export interface PostMergeIntegrationSummary {
  // not_run: no post-merge run exists for this SHA (not yet triggered, or the
  // workflow is absent). skipped: it ran and found no API change to test.
  // cancelled: superseded on a shared concurrency group before it tested
  // anything — neither coverage nor a failure; re-dispatch the workflow on dev
  // (workflow_dispatch) to get a verdict for this head.
  state: 'passing' | 'failing' | 'pending' | 'skipped' | 'cancelled' | 'not_run';
  checks: string[];
}

// The workflow's `changes` job only decides whether to test. It carries the
// advisory prefix so it never gates the release PR, but its success is not
// coverage, so it counts toward pending/failing and never toward passing.
function isPostMergeGateJob(name: string): boolean {
  return name.toLowerCase().endsWith(' / changes');
}

export function summarizePostMergeIntegration(runs: CheckRun[]): PostMergeIntegrationSummary {
  const mine = runs.filter((r) => isPostMergeIntegrationCheck(r.name));
  const checks = mine.map((r) => r.name);
  if (mine.length === 0) return { state: 'not_run', checks };
  if (mine.some((r) => r.status !== 'completed')) return { state: 'pending', checks };
  const ok = (c: string | null) => c === 'success' || c === 'neutral' || c === 'skipped';
  // A real failure outranks a cancelled sibling; cancelled alone means nothing ran.
  if (mine.some((r) => !ok(r.conclusion) && r.conclusion !== 'cancelled')) return { state: 'failing', checks };
  if (mine.some((r) => r.conclusion === 'cancelled')) return { state: 'cancelled', checks };
  const tests = mine.filter((r) => !isPostMergeGateJob(r.name));
  if (tests.every((r) => r.conclusion === 'skipped')) return { state: 'skipped', checks };
  return { state: 'passing', checks };
}

export interface ReleasePreflight {
  ref: string;
  prodBranch: string;
  // Commits on `ref` ahead of `prodBranch` — i.e., what a release would ship.
  aheadBy: number;
  shippableCommits: Array<{ sha: string; message: string }>;
  // Latest CI conclusion on the ref head, if resolvable.
  refHeadSha?: string;
  // HEAD SHA of prodBranch (what's currently deployed). Populated from the compare base.
  previousSha?: string;
  ciState?: 'passing' | 'failing' | 'pending' | 'unknown';
  failingChecks: string[];
  // An already-open release PR (ref → prodBranch), if any.
  openReleasePr?: { number: number; url: string; title: string };
  // Advisory post-merge API integration result on the ref head. Never folded
  // into ciState; informs the human deciding whether to merge the release.
  postMergeIntegration?: PostMergeIntegrationSummary;
}

// Gather everything an agent needs to decide whether triggering a release is
// safe right now: what would ship, whether the source ref is green, and whether
// a release is already in flight. Read-only.
export async function releasePreflight(
  installationId: number,
  owner: string,
  name: string,
  opts: { ref: string; prodBranch: string },
): Promise<ReleasePreflight> {
  const { ref, prodBranch } = opts;
  const out: ReleasePreflight = {
    ref,
    prodBranch,
    aheadBy: 0,
    shippableCommits: [],
    ciState: 'unknown',
    failingChecks: [],
  };

  // What's on ref ahead of prod (the release contents).
  try {
    const cmp = await githubApi(
      installationId,
      `/repos/${owner}/${name}/compare/${encodeURIComponent(prodBranch)}...${encodeURIComponent(ref)}`,
    );
    out.aheadBy = cmp?.ahead_by ?? 0;
    out.refHeadSha = cmp?.commits?.length ? cmp.commits[cmp.commits.length - 1].sha : undefined;
    out.previousSha = cmp?.base_commit?.sha as string | undefined;
    out.shippableCommits = (cmp?.commits ?? [])
      .slice(-30)
      .map((c: { sha: string; commit: { message: string } }) => ({
        sha: c.sha.slice(0, 7),
        message: (c.commit?.message ?? '').split('\n')[0],
      }));
  } catch {
    // compare can 404 if a branch is missing — leave defaults.
  }

  // CI conclusion on the ref head.
  const headSha = out.refHeadSha;
  if (headSha) {
    try {
      const checks = await githubApi(
        installationId,
        `/repos/${owner}/${name}/commits/${headSha}/check-runs?per_page=100`,
      );
      const runs: CheckRun[] = checks?.check_runs ?? [];
      const classified = classifyCheckRuns(runs);
      out.ciState = classified.ciState;
      out.failingChecks = classified.failingChecks;
      out.postMergeIntegration = summarizePostMergeIntegration(runs);
    } catch {
      out.ciState = 'unknown';
    }
  }

  // Open release PR already in flight?
  try {
    const prs = await githubApi(
      installationId,
      `/repos/${owner}/${name}/pulls?base=${encodeURIComponent(prodBranch)}&head=${encodeURIComponent(`${owner}:${ref}`)}&state=open&per_page=1`,
    );
    if (Array.isArray(prs) && prs.length > 0) {
      out.openReleasePr = { number: prs[0].number, url: prs[0].html_url, title: prs[0].title };
    }
  } catch {
    // ignore — open-PR detection is advisory.
  }

  return out;
}

// Deploy-only preflight: used when there's no distinct source ref to compare
// against prod (an unconfigured branch_merge workspace, or ref/prodBranch
// collapsing to the same branch). A self-compare always shows zero commits
// ahead and no PR ever has head==base, so instead of that meaningless
// comparison this reports CI state on prodBranch's own HEAD directly.
export async function deploymentOnlyPreflight(
  installationId: number,
  owner: string,
  name: string,
  prodBranch: string,
): Promise<ReleasePreflight> {
  const out: ReleasePreflight = {
    ref: prodBranch,
    prodBranch,
    aheadBy: 0,
    shippableCommits: [],
    ciState: 'unknown',
    failingChecks: [],
  };

  try {
    const refObj = await githubApi(installationId, `/repos/${owner}/${name}/git/ref/heads/${prodBranch}`);
    out.refHeadSha = refObj?.object?.sha as string | undefined;
    out.previousSha = out.refHeadSha;
  } catch {
    // ref lookup can fail if the branch is missing — leave ciState unknown.
  }

  if (out.refHeadSha) {
    try {
      const checks = await githubApi(
        installationId,
        `/repos/${owner}/${name}/commits/${out.refHeadSha}/check-runs?per_page=100`,
      );
      const runs: CheckRun[] = checks?.check_runs ?? [];
      const classified = classifyCheckRuns(runs);
      out.ciState = classified.ciState;
      out.failingChecks = classified.failingChecks;
    } catch {
      out.ciState = 'unknown';
    }
  }

  return out;
}
