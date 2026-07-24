import { NextRequest, NextResponse, after } from 'next/server';
import { db } from '@buildd/core/db';
import { githubInstallations, githubRepos, tasks, workers, workspaces, missions, missionNotes } from '@buildd/core/db/schema';
import { and, eq, sql, inArray, isNull, not } from 'drizzle-orm';
import { verifyWebhookSignature, allCheckSuitesPassed, hasCheckSuites, mergePullRequest, githubApi, type GitHubInstallationEvent, type GitHubIssuesEvent, type GitHubCheckSuiteEvent } from '@/lib/github';
import type { WorkspaceGitConfig, WorkspaceWorkTrackerConfig, ReleaseResult } from '@buildd/core/db/schema';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { notifyMissionPrReady } from '@/lib/mission-notifications';
import { buildCIRetryTask } from '@/lib/ci-retry';
import { notify } from '@/lib/pushover';
import { checkAndUnblockDependentMissions } from '@/lib/mission-dependency';
import { resolveReleaseStrategy } from '@buildd/core/release-strategy';
import { countPendingTasksForMission } from '@/lib/mission-release';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { postWorkTrackerCompletionUpdate } from '@/lib/work-tracker';
import { enqueueMergedPrIngestJobs, runDiffIngestJob } from '@/lib/knowledge-ingest';
import { resolvePolicy } from '@/lib/merge-policy';
import { createReviewerTask, preflightEscalationCheck } from '@/lib/reviewer';
import { tryAutoMergeWorkerPr } from '@/lib/auto-merge';
import { dispatchWorkflowRelease } from '@/lib/release/dispatch';
import { buildWorkflowRunOutcome } from '@/lib/release/workflow-run';

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

      case 'workflow_run':
        await handleWorkflowRunEvent(data);
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

const DEFAULT_INBOUND_LABELS = ['buildd', 'ai'];
const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled'];

/**
 * Create a buildd task from a labeled GitHub issue (spec §3). Idempotent per
 * (workspace, issue). When the workspace uses GitHub as its work tracker, the
 * task is also linked via externalIssueId/externalIssueUrl so the outbound
 * completion path (maybePostWorkTrackerIssueUpdate) closes the loop on merge.
 */
async function createTaskFromIssue(
  workspace: { id: string; workTrackerConfig: WorkspaceWorkTrackerConfig | null },
  issue: GitHubIssuesEvent['issue'],
  repository: GitHubIssuesEvent['repository'],
): Promise<void> {
  const externalId = `issue-${issue.id}`;

  // Idempotent: one task per (workspace, issue) whether triggered by opened or
  // labeled (or the same event redelivered).
  const existing = await db.query.tasks.findFirst({
    where: and(eq(tasks.workspaceId, workspace.id), eq(tasks.externalId, externalId)),
    columns: { id: true },
  });
  if (existing) return;

  const isGithubTracker = workspace.workTrackerConfig?.provider === 'github';

  const [newTask] = await db
    .insert(tasks)
    .values({
      workspaceId: workspace.id,
      title: issue.title,
      description: issue.body || '',
      externalId,
      externalUrl: issue.html_url,
      // Work-tracker link (github only) → enables the outbound comment on merge.
      ...(isGithubTracker
        ? { externalIssueId: String(issue.number), externalIssueUrl: issue.html_url }
        : {}),
      status: 'pending',
      context: {
        github: { issueNumber: issue.number, issueId: issue.id, repoFullName: repository.full_name },
      },
      creationSource: 'github',
      createdByAccountId: null,
      createdByWorkerId: null,
      parentTaskId: null,
    })
    .onConflictDoNothing()
    .returning();

  if (newTask) {
    await dispatchNewTask(newTask, workspace);
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

  // Trigger label(s): the workspace's configured inbound label (github work
  // tracker), else the defaults. Match is case-insensitive.
  const configuredLabel = workspace.workTrackerConfig?.inboundLabel?.toLowerCase();
  const triggerLabels = configuredLabel ? [configuredLabel] : DEFAULT_INBOUND_LABELS;
  const hasTriggerLabel = issue.labels.some((l) => triggerLabels.includes(l.name.toLowerCase()));

  switch (action) {
    // Create on open OR when the trigger label is added to an existing issue.
    case 'opened':
    case 'labeled': {
      if (!hasTriggerLabel) return;
      await createTaskFromIssue(workspace, issue, repository);
      break;
    }

    case 'closed': {
      // An externally-closed issue cancels its linked task if still open. When
      // buildd itself closed the issue after a merge, the task is already
      // terminal, so this no-ops (the guard skips terminal statuses).
      await db
        .update(tasks)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(and(
          eq(tasks.externalId, `issue-${issue.id}`),
          not(inArray(tasks.status, TERMINAL_TASK_STATUSES)),
        ));
      break;
    }

    case 'reopened': {
      // Reopening resurrects a task that a prior close had cancelled — but never
      // a task that reached completed/failed on its own.
      await db
        .update(tasks)
        .set({ status: 'pending', updatedAt: new Date() })
        .where(and(
          eq(tasks.externalId, `issue-${issue.id}`),
          eq(tasks.status, 'cancelled'),
        ));
      break;
    }
  }
}

async function handleCheckSuiteEvent(event: GitHubCheckSuiteEvent) {
  const { action, check_suite, repository, installation } = event;

  if (!installation) {
    return;
  }

  // CI started: mark worker PRs as ci_running so the Timeline shows live CI state.
  if (action === 'requested' || action === 'rerequested') {
    for (const pr of check_suite.pull_requests) {
      const worker = await db.query.workers.findFirst({
        where: eq(workers.prNumber, pr.number),
        columns: { id: true, workspaceId: true, taskId: true },
      });
      if (worker) {
        await db
          .update(workers)
          .set({ prLifecycleStatus: 'ci_running', updatedAt: new Date() })
          .where(eq(workers.id, worker.id));
        await triggerEvent(channels.workspace(worker.workspaceId), events.WORKER_PROGRESS, {
          taskId: worker.taskId,
        });
      }
    }
    return;
  }

  if (action !== 'completed') {
    return;
  }

  const headSha = check_suite.head_sha;

  // CI failure: spawn fix tasks for worker PRs AND fail tracked release PRs.
  if (check_suite.conclusion === 'failure') {
    // Mark worker PRs as ci_failed before handling retries
    for (const pr of check_suite.pull_requests) {
      const worker = await db.query.workers.findFirst({
        where: eq(workers.prNumber, pr.number),
        columns: { id: true, workspaceId: true, taskId: true },
      });
      if (worker) {
        await db
          .update(workers)
          .set({ prLifecycleStatus: 'ci_failed', updatedAt: new Date() })
          .where(eq(workers.id, worker.id));
        await triggerEvent(channels.workspace(worker.workspaceId), events.WORKER_PROGRESS, {
          taskId: worker.taskId,
        });
      }
    }
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
    merge_commit_sha?: string | null;
    head: { ref: string; sha: string };
    html_url: string;
  };
  installation?: { id: number };
  repository: { full_name: string };
}) {
  const { action, pull_request: pr, repository } = event;

  // Track PR lifecycle status on open/reopen/synchronize events
  if (
    !pr.merged &&
    (action === 'opened' || action === 'reopened' || action === 'ready_for_review' || action === 'synchronize')
  ) {
    const openWorker = await db.query.workers.findFirst({
      where: eq(workers.prNumber, pr.number),
      columns: { id: true, workspaceId: true, taskId: true, branch: true },
    });
    if (openWorker) {
      await db
        .update(workers)
        .set({ prLifecycleStatus: 'pr_open', updatedAt: new Date() })
        .where(eq(workers.id, openWorker.id));
      await triggerEvent(channels.workspace(openWorker.workspaceId), events.WORKER_PROGRESS, {
        taskId: openWorker.taskId,
      });
    }

    // On PR open (not synchronize/reopen), check merge policy and possibly dispatch reviewer
    if (!pr.draft && event.installation && action === 'opened' && openWorker?.taskId) {
      const dispatched = await maybeDispatchReviewer(
        event.installation.id,
        repository.full_name,
        pr,
        openWorker as typeof openWorker & { taskId: string },
      );
      if (dispatched) {
        // Work-tracker update still fires; skip no-CI auto-merge path
        maybePostWorkTrackerIssueUpdate(pr.number, pr.html_url, false).catch(() => {});
        return;
      }
    }

    // A freshly-opened (or un-drafted) PR on a repo with NO CI: auto-merge here,
    // because no check_suite event will ever fire to trigger the CI-gated path —
    // otherwise the PR would sit open forever. Repos WITH CI are left to the
    // check_suite handler, which waits for green.
    if (!pr.draft && event.installation && action !== 'synchronize') {
      await maybeAutoMergeNoCiPr(event.installation.id, repository.full_name, pr);
    }

    // Work-tracker: transition linked issue to "In Review" when PR is opened
    maybePostWorkTrackerIssueUpdate(pr.number, pr.html_url, false).catch(() => {});
    return;
  }

  // Only handle closed PRs beyond this point
  if (action !== 'closed') {
    return;
  }

  // Knowledge ingestion (KM v2 spec §3): ANY merged PR on a repo bound to one
  // or more workspaces enqueues a diff ingest job per workspace, then kicks
  // execution after the response is sent. Fully best-effort — never fails the
  // webhook, and jobs stay queued (retryable) if background execution is lost.
  try {
    const jobIds = await enqueueMergedPrIngestJobs({
      repoFullName: repository.full_name,
      prNumber: pr.number,
      sha: pr.merge_commit_sha ?? pr.head.sha,
    });
    if (jobIds.length > 0) {
      try {
        after(() =>
          Promise.allSettled(
            jobIds.map(id =>
              runDiffIngestJob(id).catch(err =>
                console.error(`[knowledge-ingest] job ${id} execution failed:`, err),
              ),
            ),
          ),
        );
      } catch (err) {
        // after() is unavailable outside a request scope (tests/build) — jobs
        // remain queued for a later executor.
        console.warn('[knowledge-ingest] after() unavailable; jobs remain queued:', err);
      }
    }
  } catch (err) {
    console.error('[knowledge-ingest] enqueue failed (non-fatal):', err);
  }

  // Strategy 1: Match by prNumber on workers table (agent-created PRs)
  const worker = await db.query.workers.findFirst({
    where: and(
      eq(workers.prNumber, pr.number),
    ),
    with: { task: true },
  });

  if (worker) {
    if (pr.merged) {
      // Stamp mergedAt regardless of task completion state so the dependsOn gate
      // (which checks workers.mergedAt) is unblocked for downstream tasks.
      await db
        .update(workers)
        .set({ mergedAt: new Date(), prLifecycleStatus: 'merged', updatedAt: new Date() })
        .where(eq(workers.id, worker.id));
    } else {
      // PR closed without merge (abandoned/superseded)
      await db
        .update(workers)
        .set({ prLifecycleStatus: 'closed', updatedAt: new Date() })
        .where(eq(workers.id, worker.id));
    }
    await triggerEvent(channels.workspace(worker.workspaceId), events.WORKER_PROGRESS, {
      taskId: worker.taskId,
    });
  }

  if (pr.merged && worker?.task && worker.task.status !== 'completed') {
    await db
      .update(tasks)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(tasks.id, worker.task.id));
    console.log(`Auto-completed task ${worker.task.id} via merged PR #${pr.number} on ${repository.full_name}`);

    // Work-tracker: post completion comment and transition issue to "Done"
    maybePostWorkTrackerIssueUpdate(pr.number, pr.html_url, true).catch(() => {});

    // PR merged: unblock any missions waiting on this mission's PRs to merge
    if (worker.task.missionId) {
      checkAndUnblockDependentMissions(worker.task.missionId, 'merged').catch(e =>
        console.error(`[webhook] unblock failed for merged PR mission ${worker.task!.missionId}:`, e)
      );
    }

    // Post-merge release trigger — Path B (webhook side).
    //
    // Invariant enforced here:
    //   branch_merge workspaces → Path A (worker PATCH + executeRelease) is authoritative.
    //                              Path B must NOT fire to prevent double-fire.
    //   workflow_dispatch workspaces → Path A skips; Path B fires the workflow.
    //   trigger=manual → neither path auto-fires.
    //   trigger=on_mission_complete → only fire when mission is all-terminal + atomic dedup.
    const mergedTask = worker.task;
    if (mergedTask.release !== 'false' && event.installation) {
      const mergedWorkspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, mergedTask.workspaceId),
      });
      const shouldRelease =
        mergedTask.release === 'true' ||
        (mergedTask.release === 'inherit' && mergedWorkspace?.releaseConfig?.enabled === true);

      if (shouldRelease && mergedWorkspace) {
        const releaseConfig = mergedWorkspace.releaseConfig;
        const resolution = resolveReleaseStrategy(releaseConfig);

        if (resolution.ok) {
          // branch_merge: Path A already handled the merge on task completion — skip.
          if (resolution.strategy.kind === 'branch_merge') {
            // no-op: Path A is authoritative for branch_merge workspaces
          } else if (resolution.strategy.kind === 'workflow_dispatch') {
            const trigger = releaseConfig?.trigger ?? 'every_merge';

            if (trigger === 'manual') {
              // no-op: owner fires trigger_release manually
            } else if (trigger === 'on_mission_complete') {
              // Only dispatch if this task's mission is now all-terminal
              if (mergedTask.missionId) {
                const pending = await countPendingTasksForMission(mergedTask.missionId);
                if (pending === 0) {
                  // Atomic dedup: only the first caller that sets releasedAt fires
                  const claimed = await db
                    .update(missions)
                    .set({ releasedAt: new Date() })
                    .where(
                      and(
                        eq(missions.id, mergedTask.missionId),
                        isNull(missions.releasedAt),
                      )
                    )
                    .returning({ id: missions.id });

                  if (claimed.length > 0) {
                    const { workflowFile, ref, inputs } = resolution.strategy;
                    const [owner, name] = repository.full_name.split('/');
                    try {
                      const dispatchResult = await dispatchWorkflowRelease(
                        event.installation.id,
                        owner,
                        name,
                        { workflowFile, ref, inputs: { force: 'false', ...inputs } },
                      );
                      const releaseResult: ReleaseResult = {
                        status: 'pending_ci',
                        message: `Release: dispatched ${workflowFile}@${ref} for mission ${mergedTask.missionId} — awaiting workflow completion`,
                        runId: dispatchResult.runId,
                        runUrl: dispatchResult.runUrl ?? dispatchResult.runsUrl,
                        runStatus: dispatchResult.runStatus,
                        runConclusion: dispatchResult.runConclusion ?? null,
                      };
                      await db
                        .update(tasks)
                        .set({ releaseResult, updatedAt: new Date() })
                        .where(eq(tasks.id, mergedTask.id));
                      console.log(`[webhook] Mission ${mergedTask.missionId} complete — dispatched ${workflowFile}@${ref} for ${repository.full_name} (runId=${dispatchResult.runId ?? 'pending'})`);
                    } catch (err) {
                      console.error(`[webhook] Mission release dispatch failed for ${repository.full_name}:`, err);
                    }
                  }
                }
              }
            } else {
              // every_merge (or future values): dispatch on each merged PR
              const { workflowFile, ref, inputs } = resolution.strategy;
              const [owner, name] = repository.full_name.split('/');
              try {
                const dispatchResult = await dispatchWorkflowRelease(
                  event.installation.id,
                  owner,
                  name,
                  { workflowFile, ref, inputs: { force: 'false', ...inputs } },
                );
                const releaseResult: ReleaseResult = {
                  status: 'pending_ci',
                  message: `Release: dispatched ${workflowFile}@${ref} for ${repository.full_name} — awaiting workflow completion`,
                  runId: dispatchResult.runId,
                  runUrl: dispatchResult.runUrl ?? dispatchResult.runsUrl,
                  runStatus: dispatchResult.runStatus,
                  runConclusion: dispatchResult.runConclusion ?? null,
                };
                await db
                  .update(tasks)
                  .set({ releaseResult, updatedAt: new Date() })
                  .where(eq(tasks.id, mergedTask.id));
                console.log(`[webhook] Triggered ${workflowFile}@${ref} for ${repository.full_name} (task ${mergedTask.id}, runId=${dispatchResult.runId ?? 'pending'})`);
              } catch (err) {
                console.error(`[webhook] Release dispatch failed for ${repository.full_name}:`, err);
              }
            }
          }
        }
      }
    }

    return;
  }

  // Strategy 2: Match by branch name pattern buildd/<taskId-prefix>-*
  // Only auto-complete tasks on merged PRs; a closed-without-merge PR should not complete a task.
  if (!pr.merged) {
    return;
  }
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

      if (matchingTask.missionId) {
        checkAndUnblockDependentMissions(matchingTask.missionId, 'merged').catch(e =>
          console.error(`[webhook] unblock failed for branch-match merged PR mission ${matchingTask.missionId}:`, e)
        );
      }
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

/**
 * BT-5 / BT-10: Check merge policy for an opened PR and dispatch a reviewer task
 * if the workspace is configured for agent-review.
 *
 * Returns true if we handled the PR (reviewer task created or pre-flight escalated)
 * and the caller should skip the normal no-CI auto-merge path.
 */
async function maybeDispatchReviewer(
  installationId: number,
  repoFullName: string,
  pr: { number: number; head: { sha: string }; html_url: string },
  openWorker: { id: string; workspaceId: string; taskId: string; branch: string },
): Promise<boolean> {
  try {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, openWorker.workspaceId),
    });
    if (!workspace) return false;

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, openWorker.taskId),
      columns: { id: true, title: true, description: true, missionId: true, pathManifest: true, context: true },
    });
    if (!task) return false;

    // Load mission separately to resolve merge policy
    let mission: { mergePolicy?: import('@buildd/shared').MergePolicy | null } | null = null;
    if (task.missionId) {
      const row = await db.query.missions.findFirst({
        where: eq(missions.id, task.missionId),
        columns: { mergePolicy: true },
      });
      if (row) mission = row as { mergePolicy?: import('@buildd/shared').MergePolicy | null };
    }
    const policy = resolvePolicy(workspace, mission);

    if (policy.tier !== 'agent-review') return false;

    // Fetch PR files for pre-flight check
    let prFiles: Array<{ filename: string }> = [];
    try {
      const raw = await githubApi(installationId, `/repos/${repoFullName}/pulls/${pr.number}/files?per_page=300`);
      if (Array.isArray(raw)) prFiles = raw;
    } catch (err) {
      console.warn(`[reviewer] Could not fetch PR files for pre-flight check on #${pr.number}:`, err);
    }

    // BT-10: Pre-flight escalation guard
    const preflight = preflightEscalationCheck(prFiles, policy);
    if (preflight.shouldEscalate) {
      console.log(`[reviewer] Pre-flight escalation for PR #${pr.number}: ${preflight.reason}`);
      if (task.missionId) {
        await db.insert(missionNotes).values({
          missionId: task.missionId,
          taskId: task.id,
          authorType: 'system',
          type: 'reviewer_escalated',
          title: `PR #${pr.number} escalated to human (pre-flight)`,
          body: preflight.reason,
          status: 'open',
        });
        await notifyMissionPrReady(task.missionId, {
          title: `PR #${pr.number} requires human review`,
          prUrl: pr.html_url,
          prNumber: pr.number,
          headSha: pr.head.sha,
          reason: 'auto_merge_blocked',
          message: `${task.title} — ${preflight.reason}`,
        });
      }
      notify({
        app: 'alerts',
        title: `PR #${pr.number} escalated`,
        message: preflight.reason,
        url: pr.html_url,
        urlTitle: 'View PR',
      });
      return true; // handled — skip auto-merge
    }

    // iteration/maxIterations are stored in task.context JSONB (not columns)
    const taskCtx = (task.context ?? {}) as Record<string, unknown>;
    const originalTask = {
      title: task.title,
      description: task.description,
      missionId: task.missionId ?? null,
      pathManifest: task.pathManifest as string[] | null ?? null,
      iteration: typeof taskCtx.iteration === 'number' ? taskCtx.iteration : null,
      maxIterations: typeof taskCtx.maxIterations === 'number' ? taskCtx.maxIterations : null,
    };

    // Create reviewer task
    const reviewerTask = await createReviewerTask({
      workspaceId: openWorker.workspaceId,
      originalTaskId: task.id,
      originalTask,
      worker: { branch: openWorker.branch },
      prNumber: pr.number,
      prUrl: pr.html_url,
      headSha: pr.head.sha,
      reviewerRole: policy.agentReview!.reviewerRole,
      installationId,
      repoFullName,
    });

    if (reviewerTask) {
      // dispatchNewTask needs more than just the id — pass the reviewer task details
      // we know from the params rather than re-querying the DB.
      const reviewerTaskFull = {
        id: reviewerTask.id,
        title: `[reviewer] PR #${pr.number}: ${task.title}`,
        description: null as null,
        workspaceId: openWorker.workspaceId,
        missionId: task.missionId ?? null,
      };
      await dispatchNewTask(reviewerTaskFull, workspace);
      console.log(`[reviewer] Dispatched reviewer task ${reviewerTask.id} for PR #${pr.number} on ${repoFullName}`);
    }

    return true; // handled — skip auto-merge
  } catch (err) {
    console.error(`[reviewer] maybeDispatchReviewer failed for PR #${pr.number}:`, err);
    return false;
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

// tryAutoMergeWorkerPr and evaluateAutoMergeSafety are now in @/lib/auto-merge
// (shared with the reviewer outcome handler in apps/web/src/app/api/workers/[id]/route.ts)

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

/**
 * GitHub `workflow_run` webhook — fires when any Actions workflow completes.
 *
 * This is the primary read-back mechanism for `workflow_dispatch` releases:
 * at dispatch time the handler stores `runId` in `tasks.releaseResult`; when
 * the corresponding workflow_run arrives here we look up the task by that runId
 * and stamp the final outcome (completed / failed) without any in-process polling.
 *
 * Fires for ALL workflows, not just release ones — the runId lookup makes this
 * naturally idempotent and O(1): if no task carries that runId we no-op.
 */
async function handleWorkflowRunEvent(event: {
  action: string;
  workflow_run: {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    html_url: string;
    head_branch: string | null;
    repository: { full_name: string };
  };
  installation?: { id: number };
}): Promise<void> {
  if (event.action !== 'completed') return;

  const run = event.workflow_run;

  // Find the task whose releaseResult.runId matches this workflow run.
  // The cast to int is safe because runId is always stored as a JS number (which
  // Postgres stores in JSONB as a numeric literal without quotes).
  const matchingTask = await db
    .select({
      id: tasks.id,
      releaseResult: tasks.releaseResult,
      missionId: tasks.missionId,
      workspaceId: tasks.workspaceId,
    })
    .from(tasks)
    .where(sql`(${tasks.releaseResult}->>'runId')::bigint = ${run.id}`)
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!matchingTask) return;

  const previous = (matchingTask.releaseResult ?? { status: 'pending_ci', message: '' }) as ReleaseResult;
  const updatedResult = buildWorkflowRunOutcome(previous, run);
  const succeeded = updatedResult.status === 'completed';

  await db
    .update(tasks)
    .set({ releaseResult: updatedResult, updatedAt: new Date() })
    .where(eq(tasks.id, matchingTask.id));

  console.log(
    `[webhook:workflow_run] Task ${matchingTask.id} release ${updatedResult.status} — run ${run.id} (${run.name}) on ${run.repository.full_name}`,
  );

  if (!succeeded) {
    notify({
      app: 'alerts',
      title: `Release workflow failed — ${run.name}`,
      message: `Conclusion: ${run.conclusion ?? 'unknown'}. Prod has NOT shipped. Check the run for details.`,
      url: run.html_url,
      urlTitle: 'View workflow run',
      priority: 1,
    });
  }
}

// Work-tracker helper: if the PR belongs to a task with externalIssueId set and the
// workspace has a workTracker connector, post a completion comment and transition state.
async function maybePostWorkTrackerIssueUpdate(
  prNumber: number,
  prUrl: string,
  merged: boolean,
): Promise<void> {
  const worker = await db.query.workers.findFirst({
    where: eq(workers.prNumber, prNumber),
    with: { task: true },
  });
  const task = worker?.task;
  // A tracker link is either the id (Linear) or the issue URL (GitHub).
  if (!task || (!task.externalIssueId && !task.externalIssueUrl)) return;

  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, task.workspaceId),
    columns: { workTrackerConfig: true, teamId: true },
  });
  if (!ws?.workTrackerConfig) return;

  // Provider-dispatched (Linear via connector, GitHub via the App installation).
  await postWorkTrackerCompletionUpdate({
    workspaceId: task.workspaceId,
    teamId: ws.teamId,
    config: ws.workTrackerConfig,
    externalIssueId: task.externalIssueId,
    externalIssueUrl: task.externalIssueUrl,
    prUrl,
    merged,
  });
}
