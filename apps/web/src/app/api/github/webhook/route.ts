import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { githubInstallations, githubRepos, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, sql, inArray } from 'drizzle-orm';
import { verifyWebhookSignature, allCheckSuitesPassed, hasCheckSuites, mergePullRequest, githubApi, type GitHubInstallationEvent, type GitHubIssuesEvent, type GitHubCheckSuiteEvent } from '@/lib/github';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { notifyMissionPrReady } from '@/lib/mission-notifications';
import { buildCIRetryTask } from '@/lib/ci-retry';
import { notify } from '@/lib/pushover';

export async function POST(req: NextRequest) {
  const signature = req.headers.get('x-hub-signature-256') || '';
  const event = req.headers.get('x-github-event') || '';
  const deliveryId = req.headers.get('x-github-delivery') || '';

  const payload = await req.text();

  // Verify webhook signature
  const isValid = await verifyWebhookSignature(payload, signature);
  if (!isValid) {
    console.error('Invalid webhook signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const data = JSON.parse(payload);

  console.log(`GitHub webhook: ${event} (${deliveryId})`);

  try {
    switch (event) {
      case 'installation':
        await handleInstallationEvent(data as GitHubInstallationEvent);
        break;

      case 'installation_repositories':
        await handleInstallationReposEvent(data);
        break;

      case 'issues':
        await handleIssuesEvent(data as GitHubIssuesEvent);
        break;

      case 'check_suite':
        await handleCheckSuiteEvent(data as GitHubCheckSuiteEvent);
        break;

      case 'pull_request':
        await handlePullRequestEvent(data);
        break;

      case 'ping':
        console.log('GitHub webhook ping received');
        break;

      default:
        console.log(`Unhandled event: ${event}`);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(`Webhook error (${event}):`, error);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}

async function handleInstallationEvent(event: GitHubInstallationEvent) {
  const { action, installation } = event;

  switch (action) {
    case 'created': {
      // New installation - save to database (repos are fetched on-demand)
      await db
        .insert(githubInstallations)
        .values({
          installationId: installation.id,
          accountType: installation.account.type,
          accountLogin: installation.account.login,
          accountId: installation.account.id,
          accountAvatarUrl: installation.account.avatar_url,
          permissions: installation.permissions,
          repositorySelection: installation.repository_selection,
        })
        .onConflictDoUpdate({
          target: githubInstallations.installationId,
          set: {
            accountLogin: installation.account.login,
            accountAvatarUrl: installation.account.avatar_url,
            permissions: installation.permissions,
            repositorySelection: installation.repository_selection,
            suspendedAt: null,
            updatedAt: new Date(),
          },
        });
      break;
    }

    case 'deleted': {
      // Installation removed - delete from database (cascade will delete repos)
      await db
        .delete(githubInstallations)
        .where(eq(githubInstallations.installationId, installation.id));
      break;
    }

    case 'suspend': {
      await db
        .update(githubInstallations)
        .set({ suspendedAt: new Date(), updatedAt: new Date() })
        .where(eq(githubInstallations.installationId, installation.id));
      break;
    }

    case 'unsuspend': {
      await db
        .update(githubInstallations)
        .set({ suspendedAt: null, updatedAt: new Date() })
        .where(eq(githubInstallations.installationId, installation.id));
      break;
    }
  }
}

async function handleInstallationReposEvent(event: {
  action: 'added' | 'removed';
  installation: { id: number };
  repositories_removed?: Array<{ id: number }>;
}) {
  // Only handle removals - clean up repos that were persisted when linked to a workspace
  if (event.action === 'removed' && event.repositories_removed) {
    for (const repo of event.repositories_removed) {
      await db
        .delete(githubRepos)
        .where(eq(githubRepos.repoId, repo.id));
    }
  }
}

async function handleIssuesEvent(event: GitHubIssuesEvent) {
  if (!event.installation) {
    return; // Ignore events without installation context
  }

  const { action, issue, repository } = event;

  // Find the workspace linked to this repo by full name
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.repo, repository.full_name),
  });

  if (!workspace) {
    // No workspace linked to this repo
    return;
  }

  switch (action) {
    case 'opened': {
      // Create a new task from the issue
      const hasBuilddLabel = issue.labels.some(
        (l) => l.name.toLowerCase() === 'buildd' || l.name.toLowerCase() === 'ai'
      );

      // Only auto-create tasks for issues with 'buildd' or 'ai' label
      if (!hasBuilddLabel) {
        return;
      }

      const [newTask] = await db
        .insert(tasks)
        .values({
          workspaceId: workspace.id,
          title: issue.title,
          description: issue.body || '',
          externalId: `issue-${issue.id}`,
          externalUrl: issue.html_url,
          status: 'pending',
          context: {
            github: {
              issueNumber: issue.number,
              issueId: issue.id,
              repoFullName: repository.full_name,
            },
          },
          // Creator tracking - GitHub webhook creates tasks without a user account
          creationSource: 'github',
          createdByAccountId: null,
          createdByWorkerId: null,
          parentTaskId: null,
        })
        .onConflictDoNothing() // Don't create duplicate tasks
        .returning();

      // Dispatch to connected workers and GitHub Actions
      if (newTask) {
        await dispatchNewTask(newTask, workspace);
      }
      break;
    }

    case 'closed': {
      // Mark task as completed if it exists
      await db
        .update(tasks)
        .set({
          status: 'completed',
          updatedAt: new Date(),
        })
        .where(eq(tasks.externalId, `issue-${issue.id}`));
      break;
    }

    case 'reopened': {
      // Re-open the task
      await db
        .update(tasks)
        .set({
          status: 'pending',
          updatedAt: new Date(),
        })
        .where(eq(tasks.externalId, `issue-${issue.id}`));
      break;
    }
  }
}

async function handleCheckSuiteEvent(event: GitHubCheckSuiteEvent) {
  const { action, check_suite, repository, installation } = event;

  if (action !== 'completed' || !installation) {
    return;
  }

  const headSha = check_suite.head_sha;

  // CI failure: spawn fix tasks for worker PRs AND fail tracked release PRs.
  if (check_suite.conclusion === 'failure') {
    await handleCheckSuiteFailure(check_suite, repository, installation.id);
    await handleReleasePrCiFailure(check_suite.pull_requests, repository.full_name);
    return;
  }

  // Handle CI success — auto-merge if enabled
  if (check_suite.conclusion !== 'success') {
    return;
  }

  for (const pr of check_suite.pull_requests) {
    try {
      // Find workspaces linked to this repo with autoMergePR enabled
      const linkedWorkspaces = await db.query.workspaces.findMany({
        where: eq(workspaces.repo, repository.full_name),
      });

      for (const workspace of linkedWorkspaces) {
        // Honour autoMergeOnGreenCI (CI-specific alias), fallback to autoMergePR, default true.
        const gitCfg = workspace.gitConfig;
        const shouldAutoMerge = gitCfg?.autoMergeOnGreenCI ?? gitCfg?.autoMergePR ?? true;
        if (!shouldAutoMerge) {
          continue;
        }

        // Ensure this PR was created by a Buildd worker
        const worker = await db.query.workers.findFirst({
          where: and(
            eq(workers.workspaceId, workspace.id),
            eq(workers.prNumber, pr.number),
          ),
        });

        if (!worker) {
          continue;
        }

        // Verify ALL check suites have passed (not just the triggering one)
        const allPassed = await allCheckSuitesPassed(
          installation.id,
          repository.full_name,
          headSha,
        );

        if (!allPassed) {
          console.log(`Not all check suites passed for ${repository.full_name}#${pr.number}, waiting`);
          continue;
        }

        // requiresReview gate — hold PR for human review if task or mission requires it.
        if (worker.taskId) {
          const reviewTask = await db.query.tasks.findFirst({
            where: eq(tasks.id, worker.taskId),
            with: { mission: { columns: { id: true, requiresReview: true } } },
            columns: { id: true, requiresReview: true, missionId: true, title: true },
          });

          const missionRequires = (reviewTask?.mission as { requiresReview?: boolean } | null)?.requiresReview;
          if (reviewTask && (reviewTask.requiresReview || missionRequires)) {
            console.log(`PR held for human review (requiresReview=true) — ${repository.full_name}#${pr.number}`);
            if (reviewTask.missionId) {
              await notifyMissionPrReady(reviewTask.missionId, {
                title: 'PR ready — awaiting human review',
                prUrl: `https://github.com/${repository.full_name}/pull/${pr.number}`,
                prNumber: pr.number,
                headSha,
                reason: 'awaiting_review',
                message: `${reviewTask.title} — PR #${pr.number} is ready but held for human review (requiresReview=true).`,
              });
            }
            continue;
          }
        }

        await tryAutoMergeWorkerPr({
          installationId: installation.id,
          repoFullName: repository.full_name,
          prNumber: pr.number,
          headSha,
          worker,
          gitConfig: workspace.gitConfig,
        });
      }

      // Release PR auto-merge: if this PR matches a task that is tracking a release
      // PR (context.releasePrNumber), merge it now that CI is green.
      await handleReleasePrCiSuccess(pr.number, installation.id, repository.full_name, headSha);
    } catch (error) {
      console.error(`Error processing check_suite for PR #${pr.number} on ${repository.full_name}:`, error);
    }
  }
}

async function handlePullRequestEvent(event: {
  action: string;
  pull_request: {
    number: number;
    merged: boolean;
    draft?: boolean;
    head: { ref: string; sha: string };
    html_url: string;
  };
  installation?: { id: number };
  repository: { full_name: string };
}) {
  const { action, pull_request: pr, repository } = event;

  // A freshly-opened (or un-drafted) PR on a repo with NO CI: auto-merge here,
  // because no check_suite event will ever fire to trigger the CI-gated path —
  // otherwise the PR would sit open forever. Repos WITH CI are left to the
  // check_suite handler, which waits for green.
  if (
    !pr.merged &&
    !pr.draft &&
    event.installation &&
    (action === 'opened' || action === 'reopened' || action === 'ready_for_review')
  ) {
    await maybeAutoMergeNoCiPr(event.installation.id, repository.full_name, pr);
    return;
  }

  // Only handle merged PRs beyond this point
  if (action !== 'closed' || !pr.merged) {
    return;
  }

  // Strategy 1: Match by prNumber on workers table (agent-created PRs)
  const worker = await db.query.workers.findFirst({
    where: and(
      eq(workers.prNumber, pr.number),
    ),
    with: { task: true },
  });

  if (worker?.task && worker.task.status !== 'completed') {
    await db
      .update(tasks)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(tasks.id, worker.task.id));
    console.log(`Auto-completed task ${worker.task.id} via merged PR #${pr.number} on ${repository.full_name}`);

    // Post-merge release trigger — fire release.yml if task.release indicates it.
    const mergedTask = worker.task;
    if (mergedTask.release !== 'false' && event.installation) {
      const mergedWorkspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, mergedTask.workspaceId),
      });
      const shouldRelease =
        mergedTask.release === 'true' ||
        (mergedTask.release === 'inherit' && mergedWorkspace?.releaseConfig?.enabled === true);

      if (shouldRelease && mergedWorkspace) {
        const releaseRef = mergedWorkspace.gitConfig?.defaultBranch ?? 'dev';
        try {
          await githubApi(
            event.installation.id,
            `/repos/${repository.full_name}/actions/workflows/release.yml/dispatches`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ref: releaseRef, inputs: { force: 'false' } }),
            },
          );
          console.log(`Triggered release workflow for ${repository.full_name} on ${releaseRef} (task ${mergedTask.id})`);
        } catch (err) {
          console.error(`Failed to trigger release for ${repository.full_name}:`, err);
        }
      }
    }

    return;
  }

  // Strategy 2: Match by branch name pattern buildd/<taskId-prefix>-*
  const branchMatch = pr.head.ref.match(/^buildd\/([0-9a-f]{8})-/);
  if (branchMatch) {
    const taskIdPrefix = branchMatch[1];
    // Find task by ID prefix (first 8 chars of UUID)
    const matchingTask = await db.query.tasks.findFirst({
      where: sql`${tasks.id}::text LIKE ${taskIdPrefix + '%'}`,
    });

    if (matchingTask && matchingTask.status !== 'completed') {
      await db
        .update(tasks)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(tasks.id, matchingTask.id));
      console.log(`Auto-completed task ${matchingTask.id} via branch match on merged PR #${pr.number}`);
    }
  }
}

/**
 * CI check suite failed → create a bounded fix task for the buildd worker's PR
 * and dispatch it to a runner. Part of the Ralph loop: CI fails → fix task →
 * agent fixes on the same branch → CI re-runs → (with autoMergePR) merges.
 *
 * Guard rails:
 * - Only acts on PRs created by a buildd worker.
 * - Skips draft PRs (not ready for CI feedback).
 * - Dedupes — skips if a pending/in-progress child task already exists.
 * - Honors gitConfig.maxCiRetries (default 3; 0 disables). On exhaustion, marks
 *   the original task failed and notifies the mission instead of looping.
 */
async function handleCheckSuiteFailure(
  checkSuite: GitHubCheckSuiteEvent['check_suite'],
  repository: GitHubCheckSuiteEvent['repository'],
  installationId: number,
) {
  for (const pr of checkSuite.pull_requests) {
    try {
      const worker = await db.query.workers.findFirst({
        where: eq(workers.prNumber, pr.number),
        with: { task: true },
      });
      if (!worker?.task) {
        continue;
      }
      const task = worker.task;

      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, task.workspaceId),
      });
      if (!workspace) {
        console.log(`No workspace found for task ${task.id}, skipping CI retry`);
        continue;
      }

      // Guard: skip draft PRs — not ready for CI feedback.
      const isDraft = await checkPrIsDraft(installationId, repository.full_name, pr.number);
      if (isDraft) {
        console.log(`Skipping CI retry for draft PR #${pr.number} on ${repository.full_name}`);
        continue;
      }

      // Guard: dedupe — don't pile on if a fix task is already queued/running.
      const existingRetry = await db.query.tasks.findFirst({
        where: and(
          eq(tasks.parentTaskId, task.id),
          inArray(tasks.status, ['pending', 'in_progress']),
        ),
        columns: { id: true },
      });
      if (existingRetry) {
        console.log(`Skipping CI retry for task ${task.id} — child task ${existingRetry.id} already in flight`);
        continue;
      }

      const ciLogs = await fetchCIFailureLogs(installationId, repository.full_name, checkSuite.head_sha);
      const failureContext = ciLogs.summary ||
        `CI check suite failed on ${repository.full_name} PR #${pr.number} (SHA: ${checkSuite.head_sha})`;

      const retryTask = buildCIRetryTask({
        originalTask: {
          id: task.id,
          title: task.title,
          description: task.description,
          workspaceId: task.workspaceId,
          context: (task.context as Record<string, unknown>) || {},
          missionId: task.missionId ?? null,
        },
        worker: { id: worker.id, branch: worker.branch, prNumber: worker.prNumber },
        failureContext,
        repoFullName: repository.full_name,
        ciRunId: ciLogs.runId,
        ciRunUrl: ciLogs.runUrl,
        workspaceMaxCiRetries: workspace.gitConfig?.maxCiRetries,
      });

      if (!retryTask) {
        // Retries exhausted (or disabled) — fail the task and escalate to a human.
        console.log(`CI retries exhausted/disabled for task ${task.id} on ${repository.full_name}#${pr.number}`);
        await db
          .update(tasks)
          .set({
            status: 'failed',
            result: { summary: `CI failed after max retries on PR #${pr.number}.\n\n${failureContext}` },
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, task.id));
        if (task.missionId) {
          await notifyMissionPrReady(task.missionId, {
            title: 'CI failing — retries exhausted',
            prUrl: `https://github.com/${repository.full_name}/pull/${pr.number}`,
            prNumber: pr.number,
            headSha: checkSuite.head_sha,
            reason: 'ci_failed',
            message: `${task.title} — CI still failing after max retries. Needs a human.`,
          });
        }
        continue;
      }

      const [newTask] = await db
        .insert(tasks)
        .values({
          workspaceId: retryTask.workspaceId,
          title: retryTask.title,
          description: retryTask.description,
          parentTaskId: retryTask.parentTaskId,
          missionId: retryTask.missionId,
          context: retryTask.context,
          creationSource: retryTask.creationSource,
          status: 'pending',
          priority: 7, // CI fix is urgent
        })
        .returning();

      if (newTask) {
        await dispatchNewTask(newTask, workspace);
        console.log(`Created CI retry task ${newTask.id} for failed PR #${pr.number} on ${repository.full_name} (iteration ${retryTask.context.iteration})`);
      }
    } catch (error) {
      console.error(`Error creating CI retry task for PR #${pr.number} on ${repository.full_name}:`, error);
    }
  }
}

// Check if a PR is a draft via the GitHub API. Fails open (returns false).
async function checkPrIsDraft(
  installationId: number,
  repoFullName: string,
  prNumber: number,
): Promise<boolean> {
  try {
    const pr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
    return pr?.draft === true;
  } catch (error) {
    console.warn(`Failed to check draft status for PR #${prNumber} on ${repoFullName}:`, error);
    return false;
  }
}

interface CIFailureInfo {
  /** Human-readable failed-job/step summary, or null if it couldn't be built. */
  summary: string | null;
  /** Actions run ID — lets the fix-task agent pull scoped logs via `gh run view`. */
  runId: number | null;
  runUrl: string | null;
}

// Fetch failed-job/step names from GitHub Actions for actionable retry context.
// Returns the failing-step summary plus the run id/url so the agent can pull the
// scoped logs itself (`gh run view <id> --log-failed`) rather than us shipping
// the full, verbose log down. Fields are null when nothing can be fetched.
async function fetchCIFailureLogs(
  installationId: number,
  repoFullName: string,
  headSha: string,
): Promise<CIFailureInfo> {
  const empty: CIFailureInfo = { summary: null, runId: null, runUrl: null };
  try {
    const runsData = await githubApi(
      installationId,
      `/repos/${repoFullName}/actions/runs?head_sha=${headSha}&status=failure`,
    );
    if (!runsData?.workflow_runs?.length) {
      return empty;
    }

    const run = runsData.workflow_runs[0];
    const runId = typeof run.id === 'number' ? run.id : null;
    const runUrl = typeof run.html_url === 'string' ? run.html_url : null;

    const jobsData = await githubApi(
      installationId,
      `/repos/${repoFullName}/actions/runs/${run.id}/jobs`,
    );
    if (!jobsData?.jobs?.length) {
      return { summary: null, runId, runUrl };
    }

    const failedJobs: string[] = [];
    for (const job of jobsData.jobs) {
      if (job.conclusion === 'failure') {
        const failedSteps = (job.steps || [])
          .filter((s: { conclusion?: string }) => s.conclusion === 'failure')
          .map((s: { name?: string }) => `  - Step "${s.name}" failed`)
          .join('\n');
        failedJobs.push(`Job "${job.name}" failed${failedSteps ? ':\n' + failedSteps : ''}`);
      }
    }
    if (failedJobs.length === 0) {
      return { summary: null, runId, runUrl };
    }
    return {
      summary: `CI failed on ${repoFullName} (run: ${runUrl})\n\n${failedJobs.join('\n\n')}`,
      runId,
      runUrl,
    };
  } catch (error) {
    console.warn(`Failed to fetch CI logs for ${repoFullName}@${headSha}:`, error);
    return empty;
  }
}

// For a newly-opened worker PR on a repo with no CI, attempt auto-merge now.
// Repos that DO have CI are skipped here and handled by the check_suite path
// once checks go green.
async function maybeAutoMergeNoCiPr(
  installationId: number,
  repoFullName: string,
  pr: { number: number; head: { sha: string } },
): Promise<void> {
  const linkedWorkspaces = await db.query.workspaces.findMany({
    where: eq(workspaces.repo, repoFullName),
  });

  for (const workspace of linkedWorkspaces) {
    if (!(workspace.gitConfig?.autoMergeOnGreenCI ?? workspace.gitConfig?.autoMergePR)) {
      continue;
    }

    // Only auto-merge PRs created by a Buildd worker in this workspace.
    const worker = await db.query.workers.findFirst({
      where: and(
        eq(workers.workspaceId, workspace.id),
        eq(workers.prNumber, pr.number),
      ),
    });
    if (!worker) {
      continue;
    }

    // If CI exists for this commit, defer to the check_suite handler (it waits
    // for green). Only proceed when there are genuinely no checks to wait on.
    const ciExists = await hasCheckSuites(installationId, repoFullName, pr.head.sha);
    if (ciExists) {
      console.log(`PR #${pr.number} on ${repoFullName} has CI — deferring auto-merge to check_suite`);
      continue;
    }

    console.log(`PR #${pr.number} on ${repoFullName} has no CI — attempting immediate auto-merge`);
    await tryAutoMergeWorkerPr({
      installationId,
      repoFullName,
      prNumber: pr.number,
      headSha: pr.head.sha,
      worker,
      gitConfig: workspace.gitConfig,
    });
  }
}

// Shared auto-merge step: enforce safety rails (deny paths + line budget), then
// squash-merge. On a rail violation, notify the mission instead of merging.
// Used by both the check_suite (CI-green) path and the no-CI open-PR path.
async function tryAutoMergeWorkerPr(params: {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  worker: { id: string; taskId: string | null };
  gitConfig: WorkspaceGitConfig | null | undefined;
}): Promise<void> {
  const { installationId, repoFullName, prNumber, headSha, worker, gitConfig } = params;

  const safetyCheck = await evaluateAutoMergeSafety(installationId, repoFullName, prNumber, headSha, gitConfig);
  if (!safetyCheck.ok) {
    console.log(`Auto-merge blocked for ${repoFullName}#${prNumber}: ${safetyCheck.reason}`);
    if (worker.taskId) {
      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, worker.taskId),
        columns: { missionId: true, title: true },
      });
      if (task?.missionId) {
        await notifyMissionPrReady(task.missionId, {
          title: 'Auto-merge blocked — review needed',
          prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
          prNumber,
          headSha,
          reason: 'auto_merge_blocked',
          message: `${task.title} — ${safetyCheck.reason}`,
        });
      }
    }
    return;
  }

  const result = await mergePullRequest(installationId, repoFullName, prNumber, 'squash');
  if (result.merged) {
    console.log(`Auto-merged PR #${prNumber} on ${repoFullName} for worker ${worker.id}`);
  } else {
    console.warn(`Failed to auto-merge PR #${prNumber} on ${repoFullName}: ${result.message}`);
  }
}

const DEFAULT_AUTO_MERGE_MAX_LINES = 800;

async function evaluateAutoMergeSafety(
  installationId: number,
  repoFullName: string,
  prNumber: number,
  headSha: string,
  gitConfig: { autoMergeDenyPaths?: string[]; autoMergeMaxLines?: number } | null | undefined,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // CI completeness check — verify no check runs are still pending or failing.
  try {
    const checkRunsData = await githubApi(
      installationId,
      `/repos/${repoFullName}/commits/${headSha}/check-runs`,
    );
    const checkRuns: Array<{ name: string; status: string; conclusion: string | null }> =
      checkRunsData?.check_runs ?? [];

    const pendingOrFailed = checkRuns.filter(
      (r) => r.status === 'in_progress' || r.status === 'queued' || r.conclusion === 'failure',
    );
    if (pendingOrFailed.length > 0) {
      return {
        ok: false,
        reason: `CI checks still pending or failed: ${pendingOrFailed.map((r) => r.name).join(', ')}`,
      };
    }

    // Warn if expected named checks are absent — likely means no test suite is configured.
    const runNames = checkRuns.map((r) => r.name.toLowerCase());
    const missingChecks = ['typecheck', 'build', 'test'].filter(
      (c) => !runNames.some((n) => n.includes(c)),
    );
    if (missingChecks.length > 0) {
      console.warn(
        `${repoFullName}#${prNumber}: expected CI checks not found (${missingChecks.join(', ')}) — no test suite configured?`,
      );
    }
  } catch (err) {
    console.warn(`Could not verify check runs for ${repoFullName}@${headSha}:`, err);
  }

  const denyPaths = gitConfig?.autoMergeDenyPaths ?? [];
  const maxLines = gitConfig?.autoMergeMaxLines ?? DEFAULT_AUTO_MERGE_MAX_LINES;

  let files: Array<{ filename: string; additions: number; deletions: number }> = [];
  try {
    files = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}/files?per_page=300`);
  } catch (err) {
    return { ok: false, reason: `could not fetch PR files: ${err instanceof Error ? err.message : 'unknown'}` };
  }
  if (!Array.isArray(files)) {
    return { ok: false, reason: 'malformed PR files response' };
  }

  if (denyPaths.length > 0) {
    const hit = files.find((f) => denyPaths.some((p) => f.filename.startsWith(p)));
    if (hit) {
      return { ok: false, reason: `touches protected path (${hit.filename})` };
    }
  }

  const totalLines = files.reduce((sum, f) => sum + (f.additions || 0) + (f.deletions || 0), 0);
  if (totalLines > maxLines) {
    return { ok: false, reason: `diff size ${totalLines} lines > limit ${maxLines}` };
  }

  return { ok: true };
}

/**
 * When CI goes green on a PR that a release task is tracking, merge the release
 * PR and mark the task completed. This is the event-driven completion path for
 * the pending_ci release state — the counterpart to executeRelease returning
 * pending_ci when CI is still running at the time the worker finishes.
 */
async function handleReleasePrCiSuccess(
  prNumber: number,
  installationId: number,
  repoFullName: string,
  headSha: string,
): Promise<void> {
  // Find tasks waiting on this exact release PR (context.releasePrPending = true
  // and context.releasePrNumber = prNumber).
  const pendingReleaseTasks = await db
    .select({ id: tasks.id, title: tasks.title, context: tasks.context, workspaceId: tasks.workspaceId })
    .from(tasks)
    .where(
      and(
        sql`(${tasks.context}->>'releasePrPending')::boolean = true`,
        sql`(${tasks.context}->>'releasePrNumber')::int = ${prNumber}`,
      ),
    )
    .limit(5);

  if (pendingReleaseTasks.length === 0) return;

  // Verify ALL check suites passed before merging (not just this one).
  const allPassed = await allCheckSuitesPassed(installationId, repoFullName, headSha);
  if (!allPassed) {
    console.log(`[release-pr] Not all suites passed for ${repoFullName}#${prNumber} — waiting for remaining checks`);
    return;
  }

  const mergeResult = await mergePullRequest(installationId, repoFullName, prNumber, 'merge');

  for (const task of pendingReleaseTasks) {
    const ctx = (task.context ?? {}) as Record<string, unknown>;
    const prUrl = ctx.releasePrUrl as string | undefined;

    if (mergeResult.merged) {
      const releaseResult = {
        status: 'completed' as const,
        message: `Release: completed — PR #${prNumber} merged to ${repoFullName}`,
        mergedAt: new Date().toISOString(),
        releasePrNumber: prNumber,
        releasePrUrl: prUrl,
      };
      await db
        .update(tasks)
        .set({
          status: 'completed',
          releaseResult,
          context: { ...ctx, releasePrPending: false },
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));
      console.log(`[release-pr] Task ${task.id} completed after PR #${prNumber} merged on ${repoFullName}`);
    } else {
      const errMsg = mergeResult.message;
      const releaseResult = {
        status: 'failed' as const,
        message: `Release: FAILED — could not merge PR #${prNumber}: ${errMsg}`,
        error: errMsg,
        releasePrNumber: prNumber,
        releasePrUrl: prUrl,
      };
      await db
        .update(tasks)
        .set({
          status: 'failed',
          releaseResult,
          context: { ...ctx, releasePrPending: false },
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));

      notify({
        app: 'alerts',
        title: `Release merge failed — ${repoFullName}#${prNumber}`,
        message: errMsg,
        priority: 1,
        url: prUrl || `https://github.com/${repoFullName}/pull/${prNumber}`,
        urlTitle: 'Open PR',
      });
      console.error(`[release-pr] Task ${task.id} FAILED: merge of PR #${prNumber} rejected: ${errMsg}`);
    }
  }
}

/**
 * When CI fails on a PR that a release task is tracking, mark the task as
 * FAILED and fire a Pushover alert. The release never happened.
 */
async function handleReleasePrCiFailure(
  prs: Array<{ number: number }>,
  repoFullName: string,
): Promise<void> {
  for (const pr of prs) {
    const pendingReleaseTasks = await db
      .select({ id: tasks.id, context: tasks.context })
      .from(tasks)
      .where(
        and(
          sql`(${tasks.context}->>'releasePrPending')::boolean = true`,
          sql`(${tasks.context}->>'releasePrNumber')::int = ${pr.number}`,
        ),
      )
      .limit(5);

    for (const task of pendingReleaseTasks) {
      const ctx = (task.context ?? {}) as Record<string, unknown>;
      const prUrl = ctx.releasePrUrl as string | undefined;

      const releaseResult = {
        status: 'failed' as const,
        message: `Release: FAILED — CI failing on release PR #${pr.number} (${repoFullName})`,
        error: `CI failed on PR #${pr.number}`,
        releasePrNumber: pr.number,
        releasePrUrl: prUrl,
      };
      await db
        .update(tasks)
        .set({
          status: 'failed',
          releaseResult,
          context: { ...ctx, releasePrPending: false },
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));

      notify({
        app: 'alerts',
        title: `Release CI failed — ${repoFullName}#${pr.number}`,
        message: `CI is red on release PR #${pr.number}. Prod has NOT shipped.`,
        priority: 1,
        url: prUrl || `https://github.com/${repoFullName}/pull/${pr.number}`,
        urlTitle: 'Open PR',
      });
      console.error(`[release-pr] Task ${task.id} FAILED: CI failed on release PR #${pr.number}`);
    }
  }
}
