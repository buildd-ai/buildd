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
      const runs: Array<{ id: number; status: string; conclusion: string | null; html_url: string }> =
        data?.workflow_runs ?? [];
      if (runs.length > 0) {
        const run = runs[0];
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
export function classifyCheckRuns(runs: CheckRun[]): {
  ciState: 'passing' | 'failing' | 'pending' | 'unknown';
  failingChecks: string[];
} {
  if (runs.length === 0) return { ciState: 'unknown', failingChecks: [] };
  if (runs.some((r) => r.status !== 'completed')) return { ciState: 'pending', failingChecks: [] };
  const failing = runs.filter((r) => r.conclusion && !['success', 'neutral', 'skipped'].includes(r.conclusion));
  return {
    ciState: failing.length > 0 ? 'failing' : 'passing',
    failingChecks: failing.map((r) => r.name),
  };
}

export interface ReleasePreflight {
  ref: string;
  prodBranch: string;
  // Commits on `ref` ahead of `prodBranch` — i.e., what a release would ship.
  aheadBy: number;
  shippableCommits: Array<{ sha: string; message: string }>;
  // Latest CI conclusion on the ref head, if resolvable.
  refHeadSha?: string;
  ciState?: 'passing' | 'failing' | 'pending' | 'unknown';
  failingChecks: string[];
  // An already-open release PR (ref → prodBranch), if any.
  openReleasePr?: { number: number; url: string; title: string };
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
