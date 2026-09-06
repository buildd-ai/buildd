import { db } from '@buildd/core/db';
import { isMissionIntegrationBase } from '@buildd/core/mission-integration';
import { tasks, workers, workspaces, githubRepos, releases } from '@buildd/core/db/schema';
import type { WorkspaceReleaseConfig, WorkspaceGitConfig, ReleaseResult } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { resolveReleaseStrategy, resolveReleaseTrigger } from '@buildd/core/release-strategy';
import { classifyCheckRuns, type CheckRun } from '@/lib/release/dispatch';
import { detectArchetype } from '@buildd/core/release-archetype';
import { attributeRelease } from '@buildd/core/release-attribution';
import { triggerEvent, channels, events } from '@/lib/pusher';

// Injectable for tests — do not use in production code. Mirrors the same
// affordance in release-verification.ts; without it the 8s pre-poll wait and the
// 10s poll interval below are real sleeps that blow any unit-test timeout.
let sleeper = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function _setSleeper(fn: (ms: number) => Promise<void>): void {
  sleeper = fn;
}

// Vercel deployment readback — polls until terminal state.
// Returns { state: 'SKIPPED', url: null } when VERCEL_TOKEN is absent so the
// caller can treat a missing token as "unverified" rather than a hard failure.
async function pollVercelDeployment(
  projectId: string,
  teamId: string | undefined,
  prodBranch: string,
  timeoutMs = 5 * 60 * 1000
): Promise<{ state: string; url: string | null }> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    return { state: 'SKIPPED', url: null };
  }

  const teamQuery = teamId ? `&teamId=${encodeURIComponent(teamId)}` : '';
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 10_000;

  while (Date.now() < deadline) {
    const resp = await fetch(
      `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&limit=5${teamQuery}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Vercel API error ${resp.status}: ${text}`);
    }
    const data = await resp.json();
    const deployments: Array<{ uid: string; state: string; url: string; meta?: { githubCommitRef?: string } }> =
      data.deployments ?? [];

    // Find latest production deployment on the prod branch
    const candidate = deployments.find(
      (d) => !d.meta?.githubCommitRef || d.meta.githubCommitRef === prodBranch
    ) ?? deployments[0];

    if (candidate) {
      const state: string = candidate.state;
      if (state === 'READY' || state === 'ERROR' || state === 'CANCELED') {
        return { state, url: candidate.url ? `https://${candidate.url}` : null };
      }
    }

    await sleeper(pollIntervalMs);
  }

  return { state: 'TIMEOUT', url: null };
}

// Run a single post-deploy hook
async function runHook(
  hook: NonNullable<WorkspaceReleaseConfig['postDeployHooks']>[number]
): Promise<{ description: string; success: boolean; error?: string }> {
  try {
    if (hook.type === 'http') {
      if (!hook.url) throw new Error('Hook missing url');
      const resp = await fetch(hook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(hook.headers ?? {}) },
        body: hook.params ? JSON.stringify(hook.params) : undefined,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return { description: hook.description, success: true };
    }

    if (hook.type === 'buildd_mcp') {
      // Buildd MCP HTTP transport — posts action to the buildd MCP endpoint
      const mcpUrl = process.env.BUILDD_MCP_URL || 'https://buildd.dev/api/mcp';
      const mcpKey = process.env.BUILDD_API_KEY;
      if (!mcpKey) throw new Error('BUILDD_API_KEY not set for buildd_mcp hook');
      if (!hook.action) throw new Error('Hook missing action');

      const resp = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${mcpKey}`,
        },
        body: JSON.stringify({
          action: hook.action,
          params: hook.params ?? {},
        }),
      });
      if (!resp.ok) throw new Error(`Buildd MCP ${resp.status}`);
      return { description: hook.description, success: true };
    }

    throw new Error(`Unknown hook type: ${(hook as any).type}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { description: hook.description, success: false, error: msg };
  }
}

// Find an open PR from releaseBranch → prodBranch (the "release PR" pattern).
// Returns null when no such PR is open (already merged or not yet created).
export async function findReleasePr(
  installationId: number,
  repoFullName: string,
  releaseBranch: string,
  prodBranch: string,
): Promise<{ number: number; headSha: string; url: string; title: string } | null> {
  const [owner] = repoFullName.split('/');
  if (!owner) return null;
  try {
    const path = `/repos/${repoFullName}/pulls?base=${encodeURIComponent(prodBranch)}&head=${encodeURIComponent(owner + ':' + releaseBranch)}&state=open&per_page=1`;
    const data = await githubApi(installationId, path);
    if (!Array.isArray(data) || data.length === 0) return null;
    const pr = data[0];
    return {
      number: pr.number as number,
      headSha: (pr.head as Record<string, unknown>)?.sha as string ?? '',
      url: pr.html_url as string ?? '',
      title: pr.title as string ?? '',
    };
  } catch {
    return null;
  }
}

// Check the CI state of a commit's check-runs and return a classified result.
async function getReleasePrCiState(
  installationId: number,
  repoFullName: string,
  headSha: string,
): Promise<{ ciState: 'passing' | 'failing' | 'pending' | 'unknown'; failingChecks: string[] }> {
  try {
    const data = await githubApi(installationId, `/repos/${repoFullName}/commits/${headSha}/check-runs?per_page=100`);
    const runs = (data?.check_runs ?? []) as CheckRun[];
    return classifyCheckRuns(runs);
  } catch {
    return { ciState: 'unknown', failingChecks: [] };
  }
}

// Merge a feature branch into prodBranch via GitHub API.
// Strategy: create/update a PR from the worker's branch to prodBranch, then merge it.
// Falls back to direct push merge if no PR exists.
async function mergeIntoProd(
  installationId: number,
  repoFullName: string,
  workerBranch: string,
  prNumber: number | null | undefined,
  prodBranch: string
): Promise<{ merged: boolean; sha?: string; message: string }> {
  // If the worker already has a tracked PR, merge it
  if (prNumber) {
    try {
      const mergeResp = await githubApi(
        installationId,
        `/repos/${repoFullName}/pulls/${prNumber}/merge`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ merge_method: 'squash' }),
        }
      );
      return { merged: true, sha: mergeResp?.sha, message: 'PR merged via squash' };
    } catch (err) {
      // PR may already be merged or in a non-mergeable state — try direct merge
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('405') && !msg.includes('already been merged')) {
        return { merged: false, message: `PR merge failed: ${msg}` };
      }
      // Already merged — treat as success
      if (msg.includes('already been merged')) {
        return { merged: true, message: 'PR already merged' };
      }
    }
  }

  // No PR — use GitHub merge API to merge the branch into prodBranch
  // This handles conflicts properly: GitHub will reject with 409 if conflicted
  try {
    const mergeResp = await githubApi(
      installationId,
      `/repos/${repoFullName}/merges`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base: prodBranch,
          head: workerBranch,
          commit_message: `chore: release ${workerBranch} → ${prodBranch}`,
        }),
      }
    );
    // 204 = already up-to-date
    const sha = mergeResp?.sha;
    return { merged: true, sha, message: `Branch merged into ${prodBranch}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Treat 204 (no content, already up-to-date) as success
    if (msg.includes('204')) {
      return { merged: true, message: `${prodBranch} already up-to-date` };
    }
    // 404 "Head does not exist" means the branch was already merged and deleted.
    // Treat as no-op success rather than failing the whole release.
    if (msg.includes('404') && msg.includes('Head does not exist')) {
      return { merged: true, message: `Head branch already gone — likely already merged into ${prodBranch}` };
    }
    return { merged: false, message: `Merge failed: ${msg}` };
  }
}

// Returns the id of the `releases` row this call inserted, or null when it
// inserted none (not a releasing archetype, no headSha, or the
// (workspace_id, head_sha) unique index rejected a retry of the same merge).
// The caller needs that distinction: only the inserter may promote the row.
export async function maybeCreateReleaseRow(params: {
  workspaceId: string;
  workspace: { name?: string | null; releaseConfig?: WorkspaceReleaseConfig | null; gitConfig?: WorkspaceGitConfig | null } | null | undefined;
  headSha: string | undefined;
  previousSha: string | undefined;
  repo: { fullName: string; installation: { installationId: number } };
}): Promise<string | null> {
  const { workspaceId, workspace, headSha, previousSha, repo } = params;
  if (!headSha) return null;

  const archetype = detectArchetype({
    name: workspace?.name,
    releaseConfig: workspace?.releaseConfig,
    gitConfig: workspace?.gitConfig,
  });
  // `gated` and `continuous` both genuinely release here: the gated path has
  // just merged a release PR into the prod branch, which is the release event.
  // Skipping it wrote no `releases` row and therefore no `release_tasks` edges,
  // so a gated workspace had no release history, no task→release link, and its
  // queue baseline fell through to the prod-branch-HEAD rung — a GitHub call on
  // every read, forever. `store`/`package`/`none` are not this strategy.
  if (archetype !== 'continuous' && archetype !== 'gated') return null;

  const inserted = await db
    .insert(releases)
    .values({
      workspaceId,
      archetype,
      state: 'deploying',
      // A release is HTTP-verifiable when the workspace gives us something to
      // probe, OR when it is gated (which keeps gated rows inside the cron's
      // stale-`deploying` sweep, so they still hard-fail at 24h rather than
      // sitting forever).
      //
      // The `verificationUrl` half fixes a perverse case: this used to read
      // `archetype === 'gated' ? 'http' : 'none'`, and `verifyReleaseDeployment`
      // returns early unless the strategy is exactly `'http'`. So a *continuous*
      // workspace that configured a `verificationUrl` was stamped `'none'`, its
      // probe never ran, and it never reached `healthy` — strictly worse than
      // the same workspace with no URL configured at all, which at least gets
      // promoted on a READY deploy below. Strictly additive: no row that was
      // `'http'` becomes `'none'`.
      verificationStrategy: (workspace?.releaseConfig?.verificationUrl || archetype === 'gated') ? 'http' : 'none',
      triggeredBy: 'auto',
      deployedAt: new Date(),
      headSha,
      previousSha,
    })
    // Idempotent on the (workspace_id, head_sha) unique index — a retried
    // release of the same merge commit must not double-count.
    .onConflictDoNothing()
    .returning({ id: releases.id });

  const releaseId = inserted[0]?.id ?? null;
  if (!releaseId || !previousSha) return releaseId;

  attributeRelease({
    releaseId,
    workspaceId,
    previousSha,
    headSha,
    archetype,
    repoFullName: repo.fullName,
    githubInstallationId: repo.installation.installationId,
    db,
  }).catch(() => {});

  return releaseId;
}

// Record a release for a merge into a workspace's configured prod branch that
// did NOT go through `executeRelease` at all.
//
// `scripts/release.sh` opens the release PR (dev → prodBranch) and the hotfix
// PR (feature branch → prodBranch) with the `gh` CLI; either one is then
// merged by CI/auto-merge or a human clicking the GitHub merge button, never
// by `mergeIntoProd`. No buildd worker owns that PR — a worker's `branch` and
// `prNumber` track a task's OWN feature branch into the release branch, not
// the release/hotfix PR itself — so Path A (this file, driven by a worker
// completing a task) never runs for these merges. That is the actual majority
// of a `branch_merge` workspace's real deploys, and until now none of them
// produced a `releases` row.
//
// Called from the GitHub webhook for every merged PR, independent of whether
// a worker owns it. Idempotent via the same `(workspaceId, headSha)` unique
// index `maybeCreateReleaseRow` already relies on: a worker-owned merge that
// Path A already recorded (worker-branch or release-PR flow) produces the
// identical headSha here and the insert is a no-op.
export async function recordDirectProdMerge(params: {
  repoFullName: string;
  installationId: number;
  baseRef: string;
  headSha: string | undefined;
  previousSha: string | undefined;
}): Promise<void> {
  const { repoFullName, installationId, baseRef, headSha, previousSha } = params;
  if (!headSha) return;

  const repoRows = await db
    .select({ id: githubRepos.id })
    .from(githubRepos)
    .where(eq(githubRepos.fullName, repoFullName));
  if (repoRows.length === 0) return;

  const boundWorkspaces = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      releaseConfig: workspaces.releaseConfig,
      gitConfig: workspaces.gitConfig,
    })
    .from(workspaces)
    .where(inArray(workspaces.githubRepoId, repoRows.map((r) => r.id)));

  for (const workspace of boundWorkspaces) {
    const resolution = resolveReleaseStrategy(workspace.releaseConfig);
    if (!resolution.ok || resolution.strategy.kind !== 'branch_merge') continue;
    if (resolution.strategy.prodBranch !== baseRef) continue;

    await maybeCreateReleaseRow({
      workspaceId: workspace.id,
      workspace,
      headSha,
      previousSha,
      repo: { fullName: repoFullName, installation: { installationId } },
    });
  }
}

// Promote a just-deployed release to `healthy`.
//
// Why this is a dedicated UPDATE and not a call to verifyReleaseDeployment:
//   1. It *cannot* be that call. verifyReleaseDeployment returns early unless
//      the release carries verificationStrategy 'http' AND the workspace has a
//      releaseConfig.verificationUrl — which is exactly the branch this function
//      exists to cover. Calling it here would always no-op.
//   2. verifyReleaseDeployment sleeps up to 5x15s around an HTTP probe. This
//      runs inside the worker-report request path, so it must not block on that;
//      and fire-and-forget is not an alternative — a dropped timer in a
//      serverless handler is the exact failure mode already documented in the
//      release-health-check cron header. A single UPDATE on the primary key is
//      cheap enough to await inline.
//
// The `state = 'deploying'` predicate is the optimistic lock (neon-http has no
// interactive transactions): if the webhook's verification path, the stale-
// deploying cron sweep, or the degrade watch already moved this row, this UPDATE
// matches nothing and promotes nothing rather than resurrecting a terminal row.
async function promoteReleaseToHealthy(releaseId: string, workspaceId: string): Promise<void> {
  // `isNotNull(headSha)` is not defensive filler: every release this function
  // promotes was inserted by `maybeCreateReleaseRow`, which already refuses a
  // missing headSha — but the invariant belongs on the write that flips a row
  // terminal, not on trust that every caller upstream got it right. A release
  // with no head sha has no commit range, so attribution could never have run
  // for it; letting it reach `healthy` anyway is the exact bug this guards.
  const [promoted] = await db
    .update(releases)
    .set({ state: 'healthy', healthyAt: new Date() })
    .where(and(eq(releases.id, releaseId), eq(releases.state, 'deploying'), isNotNull(releases.headSha)))
    .returning({ id: releases.id });

  if (!promoted) return;

  await triggerEvent(channels.workspace(workspaceId), events.RELEASE_UPDATED, {
    releaseId,
    state: 'healthy',
  }).catch(() => {});
}

export interface ReleaseInput {
  taskId: string;
  workerId: string;
  workspaceId: string;
  // When true: called from the mission-complete hook, not per-task. Bypasses
  // per-task trigger policy so the mission release actually fires.
  isMissionRelease?: boolean;
}

/**
 * `ReleaseResult` plus the reason a `skipped` was a *policy* refusal rather than
 * a failure.
 *
 * Declared here rather than widened in `packages/core/db/schema.ts` on purpose:
 * that interface is the `$type` of `tasks.releaseResult`, and editing it — even
 * type-only — invites the "changed schema.ts without a migration" gate. This
 * field never needs to persist; it exists so the caller can tell "this mission
 * releases through its mission PR" from "the release broke", which reads
 * identically today and puts a `Mission release attempt failed` note on the
 * mission feed for the intended path.
 */
export type ReleaseOutcome = ReleaseResult & {
  skipReason?: 'mission_integration_branch';
};

export async function executeRelease(input: ReleaseInput): Promise<ReleaseOutcome> {
  const { taskId, workerId, workspaceId, isMissionRelease = false } = input;

  // Fetch task release flag and worker PR info
  const [task, worker, workspace] = await Promise.all([
    db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { release: true, missionId: true },
      // Option A′ — see the integration-branch refusal below.
      with: { mission: { columns: { workingBranch: true, integrationBranchEnabled: true } } },
    }),
    db.query.workers.findFirst({
      where: eq(workers.id, workerId),
      columns: { branch: true, prNumber: true, prUrl: true, prBaseRef: true },
    }),
    db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { releaseConfig: true, githubRepoId: true, name: true, gitConfig: true },
    }),
  ]);

  const releaseFlag = (task?.release ?? 'inherit') as 'true' | 'false' | 'inherit';
  const releaseConfig = workspace?.releaseConfig ?? null;

  // Determine if release should run
  if (releaseFlag === 'false') {
    return { status: 'skipped', message: 'Release: not requested (suppressed by task flag)' };
  }

  // Option A′: a task of a mission using an integration branch must never
  // release from its own branch.
  //
  // The worker-branch path below merges `worker.branch` directly into the prod
  // branch. Under A′ a mission task's branch is cut from the integration branch,
  // so that merge would carry the task's commits PLUS every sibling commit
  // already sitting on the integration branch and not yet on trunk — shipping
  // unreviewed work to production and bypassing the mission PR, which is the one
  // human gate A′ exists to create. It routes around exactly the control it was
  // built to add.
  //
  // The mission's work reaches production the normal way: the mission PR merges
  // into trunk, and the workspace's trunk→prod release flow ships it. This
  // refusal is a `skipped`, which the caller records as a refusal rather than a
  // release (see mission-release.ts's two-phase claim), so it is visible rather
  // than silent.
  if (isMissionIntegrationBase({ baseRef: worker?.prBaseRef, mission: task?.mission })) {
    return {
      status: 'skipped',
      message:
        `Release: task PR targets the mission integration branch `
        + `(${task?.mission?.workingBranch ?? 'unknown'}) — the mission PR is the release unit, not this task.`,
      skipReason: 'mission_integration_branch',
    };
  }

  // Second arm: the release SOURCE must never be the integration branch itself.
  //
  // The arm above asks "where does this task's PR land", which catches a
  // deliverable task of an A′ mission. It says nothing about the mission's own
  // bookkeeping owner row, whose `prBaseRef` is TRUNK — the mission PR's base —
  // while its `workers.branch` IS the integration branch. The worker-branch path
  // below would then mergeIntoProd(worker.branch): `mission/<slug>` straight into
  // the prod branch, bypassing both the mission PR and trunk, carrying every
  // sibling commit on that branch to production unreviewed.
  //
  // Reachable today, and nondeterministically so: attemptMissionRelease releases
  // through the mission's most recently updated completed task that has a worker
  // (`tasks.updatedAt desc`), so whether a mission hit the arm above or this
  // direct-to-prod merge depended on which row that ordering surfaced.
  //
  // `isMissionIntegrationBase` reads oddly with a branch in the `baseRef` slot,
  // but it is exactly the question being asked — "is this ref this mission's
  // integration branch" — and it is the authoritative form, comparing against
  // `missions.workingBranch` rather than pattern-matching a name. It is also
  // flag-gated, so a mission that never opted in is untouched even if its working
  // branch is named `mission/…`. (Where the mission row is not in scope, the
  // shape fallback is `looksLikeMissionIntegrationBranch` from the same module.)
  if (isMissionIntegrationBase({ baseRef: worker?.branch, mission: task?.mission })) {
    return {
      status: 'skipped',
      message:
        `Release: the release source is the mission integration branch `
        + `(${worker?.branch}) — it reaches production through the mission PR into `
        + `trunk, never by a direct merge to the prod branch.`,
      skipReason: 'mission_integration_branch',
    };
  }

  // Trigger policy: governs cadence. Per-task releases check this; mission-
  // driven releases (isMissionRelease=true) bypass so the hook actually fires.
  if (!isMissionRelease) {
    const trigger = resolveReleaseTrigger(releaseConfig);
    if (trigger === 'manual') {
      return { status: 'skipped', message: 'Release: trigger=manual — use trigger_release to release manually.' };
    }
    if (trigger === 'on_mission_complete') {
      return { status: 'skipped', message: 'Release: trigger=on_mission_complete — fires after all mission tasks complete.' };
    }
    // trigger === 'every_merge' or absent: proceed as normal
  }

  // Resolve the workspace's declared strategy. executeRelease is the
  // on-task-completion merge path, so it only handles 'branch_merge'; other
  // strategies (workflow_dispatch/script) run via the standalone trigger.
  const resolution = resolveReleaseStrategy(releaseConfig);
  if (!resolution.ok) {
    if (releaseFlag === 'true') {
      // Explicit request but unusable config — fail loudly.
      return {
        status: 'failed',
        message: `Release: FAILED — task requested release but ${resolution.message}.`,
        error: resolution.message,
      };
    }
    return { status: 'not_configured', message: `Release: ${resolution.message}` };
  }

  if (resolution.strategy.kind !== 'branch_merge') {
    return {
      status: 'skipped',
      message: `Release: workspace uses the ${resolution.strategy.kind} strategy — not run on task completion (use trigger_release).`,
    };
  }

  const branchMerge = resolution.strategy;
  const { prodBranch } = branchMerge;

  // Step 1: Merge into prodBranch
  let mergedAt: string | undefined;
  let mergeSha: string | undefined;
  // Non-null only when THIS call inserted the releases row (see Step 2.5).
  let createdReleaseId: string | null = null;

  // Get GitHub repo for this workspace (needed for both releaseBranch and worker-branch paths)
  const repo = workspace?.githubRepoId
    ? await db.query.githubRepos.findFirst({
        where: eq(githubRepos.id, workspace.githubRepoId),
        with: { installation: true },
      })
    : null;

  if (!repo?.installation) {
    return {
      status: 'failed',
      message: 'Release: FAILED — workspace has no linked GitHub repo/installation',
      error: 'No GitHub installation',
    };
  }

  if (branchMerge.releaseBranch) {
    // "Release PR" path: a dedicated release task creates a PR from releaseBranch →
    // prodBranch (e.g. dev → main via `bun run release`). Only run this path for
    // tasks that explicitly requested release (`release: 'true'`). Feature tasks with
    // `release: 'inherit'` land their work on releaseBranch via auto-merge; the
    // dev→main promotion happens separately when the release task runs. Entering this
    // path for feature tasks causes every feature task to fail with "no open release
    // PR found" whenever there is no dev→main PR open — which is most of the time.
    if (releaseFlag !== 'true') {
      return {
        status: 'skipped',
        message: `Release: feature task — code lands on ${branchMerge.releaseBranch} and is promoted to ${prodBranch} by the release task.`,
      };
    }

    const releasePr = await findReleasePr(
      repo.installation.installationId,
      repo.fullName,
      branchMerge.releaseBranch,
      prodBranch,
    );

    if (!releasePr) {
      return {
        status: 'failed',
        message: `Release: FAILED — no open release PR found from ${branchMerge.releaseBranch} to ${prodBranch}. Run \`bun run release\` first or check if the PR was already merged.`,
        error: 'No open release PR found',
      };
    }

    const { ciState, failingChecks } = await getReleasePrCiState(
      repo.installation.installationId,
      repo.fullName,
      releasePr.headSha,
    );

    if (ciState === 'failing') {
      return {
        status: 'failed',
        message: `Release: FAILED — CI failing on release PR #${releasePr.number} (${releasePr.url}). Fix: ${failingChecks.join(', ')}`,
        error: `CI failing: ${failingChecks.join(', ')}`,
        releasePrNumber: releasePr.number,
        releasePrUrl: releasePr.url,
      };
    }

    if (ciState === 'pending' || ciState === 'unknown') {
      // CI hasn't finished — return pending_ci so the workers route can track
      // the PR number and the webhook handler can complete the task when CI resolves.
      return {
        status: 'pending_ci',
        message: `Release: CI pending on release PR #${releasePr.number} (${releasePr.url}) — task will complete/fail when CI finishes.`,
        releasePrNumber: releasePr.number,
        releasePrUrl: releasePr.url,
      };
    }

    // Fetch prodBranch HEAD before merge so releases row has previousSha
    let rbPreviousSha: string | undefined;
    try {
      const ref = await githubApi(repo.installation.installationId, `/repos/${repo.fullName}/git/ref/heads/${prodBranch}`);
      rbPreviousSha = ref?.object?.sha as string | undefined;
    } catch { /* non-fatal */ }

    // CI is passing — merge the release PR now
    const mergeResp = await githubApi(
      repo.installation.installationId,
      `/repos/${repo.fullName}/pulls/${releasePr.number}/merge`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merge_method: 'merge' }),
      },
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return { merged: false, message: msg } as Record<string, unknown>;
    });

    if (!mergeResp?.sha && mergeResp?.merged === false) {
      return {
        status: 'failed',
        message: `Release: FAILED — could not merge release PR #${releasePr.number}: ${mergeResp.message ?? 'merge failed'}`,
        error: String(mergeResp.message ?? 'merge failed'),
        releasePrNumber: releasePr.number,
        releasePrUrl: releasePr.url,
      };
    }

    mergedAt = new Date().toISOString();
    mergeSha = mergeResp.sha as string | undefined;

    createdReleaseId = await maybeCreateReleaseRow({ workspaceId, workspace, headSha: mergeSha, previousSha: rbPreviousSha, repo });
  } else if (worker?.branch) {
    // Worker-branch path: merge the worker's feature branch into prodBranch

    // Fetch prodBranch HEAD before merge so releases row has previousSha
    let wbPreviousSha: string | undefined;
    try {
      const ref = await githubApi(repo.installation.installationId, `/repos/${repo.fullName}/git/ref/heads/${prodBranch}`);
      wbPreviousSha = ref?.object?.sha as string | undefined;
    } catch { /* non-fatal */ }

    const mergeResult = await mergeIntoProd(
      repo.installation.installationId,
      repo.fullName,
      worker.branch,
      worker.prNumber,
      prodBranch
    );

    if (!mergeResult.merged) {
      return {
        status: 'failed',
        message: `Release: FAILED — could not merge to ${prodBranch}: ${mergeResult.message}`,
        error: mergeResult.message,
      };
    }

    mergedAt = new Date().toISOString();
    mergeSha = mergeResult.sha;

    createdReleaseId = await maybeCreateReleaseRow({ workspaceId, workspace, headSha: mergeSha, previousSha: wbPreviousSha, repo });
  }

  // Step 2: Poll Vercel for deployment
  let deployUrl: string | null = null;
  let deployState: string | undefined;

  if (branchMerge.deployTarget?.type === 'vercel') {
    const { projectId, teamId } = branchMerge.deployTarget;
    if (!projectId) {
      return {
        status: 'failed',
        message: 'Release: FAILED — deployTarget.projectId is required for Vercel deploys',
        error: 'Missing Vercel projectId',
      };
    }

    try {
      // Only wait for Vercel to pick up the push when we can actually verify.
      // When VERCEL_TOKEN is absent, pollVercelDeployment returns SKIPPED immediately.
      if (process.env.VERCEL_TOKEN) {
        await sleeper(8_000);
      }
      const deploy = await pollVercelDeployment(projectId, teamId, prodBranch);
      deployState = deploy.state;
      deployUrl = deploy.url;

      // SKIPPED means the token was absent — treat as unverified, not failed.
      if (deploy.state !== 'READY' && deploy.state !== 'SKIPPED') {
        const hookResults: ReleaseResult['hooksRan'] = [];
        return {
          status: 'failed',
          message: `Release: FAILED — Vercel deploy ${deploy.state}${deploy.url ? ` at ${deploy.url}` : ''}`,
          mergedAt,
          deployUrl: deploy.url ?? undefined,
          deployState: deploy.state,
          hooksRan: hookResults,
          error: `Deploy state: ${deploy.state}`,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        message: `Release: FAILED — Vercel polling error: ${msg}`,
        mergedAt,
        error: msg,
      };
    }
  }

  // Step 2.5: promote to `healthy` when a successful deploy is the only health
  // signal this workspace has.
  //
  // Before this, `healthy` had exactly one writer (verifyReleaseDeployment) and
  // that writer bails unless a releaseConfig.verificationUrl is configured. A
  // workspace without one had no path to `healthy` at all: rows sat in
  // `deploying` forever, MAX(healthy_at) stayed NULL, and the baseline ladder
  // could never reach its top rung.
  //
  // Two deliberate non-promotions:
  //   - `SKIPPED` means VERCEL_TOKEN was absent, so pollVercelDeployment never
  //     looked at the deployment. That is *unverified*, not healthy — promoting
  //     it would launder a missing credential into a green release.
  //   - a configured verificationUrl means the HTTP probe is authoritative;
  //     the executor promotes nothing and lets that path decide.
  if (createdReleaseId && deployState === 'READY' && !releaseConfig?.verificationUrl) {
    await promoteReleaseToHealthy(createdReleaseId, workspaceId);
  }

  // Step 3: Post-deploy hooks
  const hooksRan: NonNullable<ReleaseResult['hooksRan']> = [];
  let hookFailed = false;

  if (branchMerge.postDeployHooks && branchMerge.postDeployHooks.length > 0) {
    for (const hook of branchMerge.postDeployHooks) {
      const result = await runHook(hook);
      hooksRan.push(result);
      if (!result.success) hookFailed = true;
    }
  }

  // Compose final result
  const vercelLine = deployState === 'SKIPPED'
    ? ' (Vercel unverified — VERCEL_TOKEN not set)'
    : deployUrl ? ` at ${deployUrl}` : '';
  const readyLabel = deployState === 'SKIPPED' ? 'deployed' : 'READY';
  const summaryLine = hookFailed
    ? `Release: completed with hook errors — prod ${readyLabel}${vercelLine}`
    : `Release: completed, prod ${readyLabel}${vercelLine}`;

  return {
    status: 'completed',
    message: summaryLine,
    mergedAt,
    deployUrl: deployUrl ?? undefined,
    deployState: deployState ?? 'READY',
    hooksRan: hooksRan.length > 0 ? hooksRan : undefined,
  };
}
