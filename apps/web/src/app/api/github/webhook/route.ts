import { registerLocalPr } from '@/lib/register-local-pr';
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';
import { NextRequest, NextResponse, after } from 'next/server';
import { db } from '@buildd/core/db';
import { reportTaskPolicyOutcome } from '@/lib/model-policy-outcomes';
import { githubInstallations, githubRepos, tasks, workers, workspaces, missions, missionNotes } from '@buildd/core/db/schema';
import { and, eq, sql, inArray, isNull, not, or, ne, desc } from 'drizzle-orm';
import { verifyWebhookSignature, allCheckSuitesPassed, hasCheckSuites, mergePullRequest, githubApi, type GitHubInstallationEvent, type GitHubIssuesEvent, type GitHubCheckSuiteEvent } from '@/lib/github';
import type { WorkspaceGitConfig, WorkspaceWorkTrackerConfig } from '@buildd/core/db/schema';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { notifyOperator } from '@/lib/pushover';
import { notifyTeamOf } from '@/lib/notify';
import { isMissionPrTask, looksLikeMissionIntegrationBranch, resolveTaskPrBase } from '@buildd/core/mission-integration';
import { buildMissionBaseGuard } from '@/lib/mission-base-guard';
import { resolveCompletedTask } from '@/lib/task-dependencies';
import { detachInteractiveWorkersOfEndedTasks } from '@/lib/interactive-detach';
import { otherOpenPrsOfTask } from '@/lib/task-open-prs';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { enqueueMergedPrIngestJobs, enqueuePushIngestJobs, runDiffIngestJob } from '@/lib/knowledge-ingest';
import { resolvePolicy } from '@/lib/merge-policy';
import { tryAutoMergeWorkerPr } from '@/lib/auto-merge';
import { detectDarkChecksForClosedPr } from './dark-check-detection';
import { syncInstallationReposById } from '@/lib/github-repo-link';
import { workerOwnsPr, workspaceRepoMatches, prUrlFor } from '@/lib/repo-scope';
import { emit } from '@/lib/core-emit';
import { emitHeldReleaseOutcome } from '@/lib/task-outcome-event';
import { PR_OPENED_POLICY } from '@/modules';
import type { PrOwnerFact } from '@/lib/core-events';
import { maybePostWorkTrackerIssueUpdate, runMergedPrWork } from '@/lib/pr-merged-work';
import { requestRecheckForMergedDocFix } from '@/lib/spec-recheck';
import { releaseAndNotify } from '@/lib/path-claim-release';
import { schedulePrScopeReconcile } from '@/lib/pr-scope-reconcile-trigger';
import { applyTaskCancelSideEffects, applyTaskReopenSideEffects } from '@/lib/task-cancel';
import { readPrReviewStatus } from '@/lib/pr-review-request';
import { isApprovalSelfMergeable } from '@/lib/pr-review-status';
import { carryForwardApprovalIfUnchanged } from '@/lib/approval-carry-forward';
import { landPr, resolveLandingMode } from '@/lib/pr-landing';
import { guardReviewVerdict } from '@/lib/review-verdict-gate';
import { fireGateEvent, GATE_SLUGS } from '@/lib/gate-ledger';
import { recordPrReverts } from '@/lib/pr-reverts';
import { recordPrFact } from '@buildd/core/pr-facts';
import { authorsFromPushCommits, changedFilesFromPush, isPossibleBaseRef, type BaseAdvanceInput, type BaseResolver } from '@/lib/base-advance-notice';
import { changedFilesForCompare, changedFilesForPr, runBaseAdvanceNotice } from '@/lib/base-advance-notice-store';
import { promptEvalRefForPush } from '@/lib/prompt-evals/push-trigger';
import { runPromptEval } from '@/lib/prompt-evals/run';
import { promptEvalDeps } from '@/lib/prompt-evals/store';
import { observePrState } from '@/lib/workflow/seam';

// A push to the prompts repo runs the prompt eval in after() (up to ~240s).
export const maxDuration = 300;

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

      case 'pull_request_review':
        await handlePullRequestReviewEvent(data);
        break;

      case 'pull_request_review_comment':
        await handlePullRequestReviewCommentEvent(data);
        break;

      case 'workflow_run':
        await handleWorkflowRunEvent(data);
        break;

      case 'push':
        await handlePushEvent(data);
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
      // New installation - save the row, then immediately mirror its repos into
      // github_repos and back-link matching workspaces. Doing this here (rather
      // than only on the Settings "Sync" click) is what makes a fresh install
      // usable: create_pr needs workspaces.githubRepoId, and the Settings page
      // only lists installations that some workspace already points at, so a
      // never-linked installation is unreachable from the UI.
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
      await backLinkInstallationRepos(installation.id, 'installation.created');
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
  if (event.action === 'removed' && event.repositories_removed) {
    // Clean up repos that were persisted when linked to a workspace
    for (const repo of event.repositories_removed) {
      await db
        .delete(githubRepos)
        .where(eq(githubRepos.repoId, repo.id));
    }
    return;
  }

  if (event.action === 'added') {
    // Granting the app access to more repos back-links matching workspaces too.
    // Re-syncing the whole installation (rather than just repositories_added)
    // keeps one idempotent code path and picks up metadata the payload omits
    // (default_branch, description).
    await backLinkInstallationRepos(event.installation.id, 'installation_repositories.added');
  }
}

/**
 * Mirror an installation's repos into github_repos and back-link any workspace
 * whose `repo` matches but has no githubRepoId. Never throws: a GitHub API
 * hiccup must not fail the delivery (GitHub does not retry App webhooks), so
 * failures page instead and the manual Settings sync remains the fallback.
 */
async function backLinkInstallationRepos(installationId: number, source: string) {
  try {
    const { synced, linked, linkedWorkspaceIds } = await syncInstallationReposById(installationId);
    console.log(
      `[github-repo-link] ${source}: installation ${installationId} synced ${synced} repo(s), ` +
        `back-linked ${linked} workspace(s)${linked > 0 ? ` (${linkedWorkspaceIds.join(', ')})` : ''}`
    );
    if (linked > 0) {
      notifyOperator({
        title: 'GitHub repos linked',
        message: `${source}: back-linked ${linked} workspace(s) to installation ${installationId}`,
      });
    }
  } catch (err) {
    console.error(`[github-repo-link] ${source} failed for installation ${installationId}:`, err);
    notifyOperator({
      app: 'alerts',
      title: 'GitHub repo back-link failed',
      message: `${source} for installation ${installationId}: ${err instanceof Error ? err.message : String(err)}`,
      priority: 0,
    });
  }
}

const DEFAULT_INBOUND_LABELS = ['buildd', 'ai'];
// PR lifecycle statuses are written only through recordPrFact
// (@buildd/core/pr-facts), which keeps merged/closed/unresolvable terminal and
// drops a CI fact for a SHA that is no longer the PR's head.

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
      taskClass: 'work',
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
    await announceTaskCreated(newTask, workspace);
    await wakeTask(newTask.id, 'task.created');
  }
}

async function handleIssuesEvent(event: GitHubIssuesEvent) {
  if (!event.installation) {
    return; // Ignore events without installation context
  }

  const { action, issue, repository } = event;

  // Find the workspace linked to this repo by full name
  const workspace = await db.query.workspaces.findFirst({
    where: workspaceRepoMatches(repository.full_name),
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
      // terminal, so the guard skips it and no side effects run.
      const cancelled = await db
        .update(tasks)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(and(
          eq(tasks.externalId, `issue-${issue.id}`),
          not(inArray(tasks.status, TERMINAL_TASK_STATUSES)),
        ))
        .returning({ id: tasks.id, workspaceId: tasks.workspaceId, missionId: tasks.missionId });
      // Only rows this UPDATE actually changed: abort the worker (it would
      // otherwise keep spending tokens), release path claims, resolve, emit.
      for (const row of cancelled) {
        await applyTaskCancelSideEffects(row);
      }
      break;
    }

    case 'reopened': {
      // Reopening resurrects a task that a prior close had cancelled — but never
      // a task that reached completed/failed on its own. Claim fields are cleared
      // like a PATCH reset to pending, so the task is claimable again.
      const reopened = await db
        .update(tasks)
        .set({ status: 'pending', claimedBy: null, claimedAt: null, expiresAt: null, updatedAt: new Date() })
        .where(and(
          eq(tasks.externalId, `issue-${issue.id}`),
          eq(tasks.status, 'cancelled'),
        ))
        .returning({ id: tasks.id, workspaceId: tasks.workspaceId, missionId: tasks.missionId });
      for (const row of reopened) {
        await applyTaskReopenSideEffects(row, 'GitHub issue reopened');
      }
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
        where: workerOwnsPr(repository.full_name, pr.number),
        columns: { id: true, workspaceId: true, taskId: true, prLifecycleStatus: true },
      });
      // A CI fact on the fact cache (recordPrFact): a merged or closed PR keeps
      // its terminal status, and a suite for a SHA that is no longer the PR's
      // head is dropped (§16 S6).
      const applied = worker
        ? await recordPrFact({ workerId: worker.id }, { kind: 'ci', status: 'ci_running', headSha: check_suite.head_sha, currentHeadSha: pr.head?.sha ?? null })
        : [];
      if (worker && applied.length > 0) {
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
    // Mark worker PRs as ci_failed before handling retries.
    // Skip workers whose PR is already in a terminal state (merged/closed) — a late
    // failure webhook must not overwrite a merged PR's lifecycle status (AC-4).
    for (const pr of check_suite.pull_requests) {
      const worker = await db.query.workers.findFirst({
        where: workerOwnsPr(repository.full_name, pr.number),
        columns: { id: true, workspaceId: true, taskId: true, prLifecycleStatus: true },
      });
      const applied = worker
        ? await recordPrFact({ workerId: worker.id }, { kind: 'ci', status: 'ci_failed', headSha, currentHeadSha: pr.head?.sha ?? null })
        : [];
      if (worker && (applied.length > 0 || (worker.prLifecycleStatus === 'ci_failed' && (!pr.head?.sha || pr.head.sha === headSha)))) {
        await triggerEvent(channels.workspace(worker.workspaceId), events.WORKER_PROGRESS, {
          taskId: worker.taskId,
        });
        // Model policy: CI on the run's PR is its tests observation.
        await reportTaskPolicyOutcome(worker.taskId, [{ type: 'tests', passed: false }]);
      }
    }
    // Per PR: the subscriptions ledger records "CI went red on PR N" (one row
    // per head SHA), then the reviews module asks for a bounded CI-fix task.
    for (const pr of check_suite.pull_requests) {
      await emit({ type: 'pr.ci_failed', repoFullName: repository.full_name, prNumber: pr.number, headSha, installationId: installation.id });
    }
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
        where: workspaceRepoMatches(repository.full_name),
      });

      for (const workspace of linkedWorkspaces) {
        // Ensure this PR was created by a Buildd worker
        const worker = await db.query.workers.findFirst({
          where: and(
            eq(workers.workspaceId, workspace.id),
            workerOwnsPr(repository.full_name, pr.number),
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

        // Mark CI as green — used by pr_checks_green loop exit condition evaluation.
        // Skip if the PR is already in a terminal state (merged/closed wins).
        // A merged or closed PR keeps its terminal status (recordPrFact).
        const greened = await recordPrFact({ workerId: worker.id }, { kind: 'ci', status: 'ci_green', headSha, currentHeadSha: pr.head?.sha ?? null });
        // Model policy: every check suite passed on the run's PR (once per transition to green).
        if (greened.length > 0) {
          await reportTaskPolicyOutcome(worker.taskId, [{ type: 'tests', passed: true }]);
          await emit({ type: 'pr.ci_passed', repoFullName: repository.full_name, prNumber: pr.number, headSha, installationId: installation.id });
        }

        // Resolve merge policy via the single precedence chain:
        //   task.requiresReview → mission integration branch → mission.mergePolicy
        //   → mission.requiresReview → workspace.mergePolicy → default
        let workerTask: { requiresReview: boolean; missionId: string | null; title: string; mission: { mergePolicy?: import('@buildd/shared').MergePolicy | null; requiresReview: boolean; workingBranch: string | null; integrationBranchEnabled: boolean } | null } | undefined;
        if (worker.taskId) {
          workerTask = await db.query.tasks.findFirst({
            where: eq(tasks.id, worker.taskId),
            with: { mission: { columns: { mergePolicy: true, requiresReview: true, workingBranch: true, integrationBranchEnabled: true } } },
            columns: { id: true, requiresReview: true, missionId: true, title: true },
          }) as typeof workerTask;
        }
        // Prefer the check_suite payload's base ref — it is authoritative and
        // race-free — and fall back to the stored column. This is a gate that
        // decides whether auto-merge fires, and `worker.prBaseRef` can be stale
        // for a retargeted PR, in the direction that DROPS a human review gate.
        // Null (unknown) leaves the chain untouched.
        const policy = resolvePolicy(
          workspace,
          workerTask?.mission ?? null,
          workerTask ?? null,
          { baseRef: pr.base?.ref ?? worker.prBaseRef },
        );

        if (policy.tier === 'human') {
          console.log(`PR held for human review (policy.tier=human) — ${repository.full_name}#${pr.number}`);
          if (workerTask?.missionId) {
            await emit({ type: 'pr.needs_human', missionId: workerTask.missionId,
              title: 'PR ready — awaiting human review',
              prUrl: `https://github.com/${repository.full_name}/pull/${pr.number}`,
              prNumber: pr.number,
              headSha,
              reason: 'awaiting_review',
              message: `${workerTask.title} — PR #${pr.number} is ready but held for human review.`,
            });
          }
          continue;
        }

        // The landing function (lib/pr-landing.ts) owns this decision once the
        // workspace is in `enforce`: carry-forward, the verdict, the rails and
        // "behind base" as a refresh with a marker, on the LIVE head. A green
        // for a head that is no longer live is a no-op inside it. In `shadow`
        // it only records what it would have done, before the legacy path
        // below acts on the same state.
        const landingMode = resolveLandingMode(workspace.gitConfig);
        if (landingMode !== 'off') {
          const outcome = await landPr({
            workspaceId: workspace.id,
            installationId: installation.id,
            repoFullName: repository.full_name,
            prNumber: pr.number,
            eventHeadSha: headSha,
            door: 'check_suite',
            actor: { kind: 'system' },
            mode: landingMode,
            policy,
            owner: { taskId: worker.taskId ?? null, workerId: worker.id },
            releaseConfig: workspace.releaseConfig ?? null,
            gitConfig: workspace.gitConfig ?? null,
          });
          if (landingMode === 'enforce') {
            console.log(`[pr-landing] check_suite ${repository.full_name}#${pr.number}@${headSha}: ${outcome.kind}`);
            continue;
          }
        }

        if (policy.tier === 'agent-review') {
          // Reviewer was dispatched when the PR was opened; it normally merges
          // on approve. But that merge is bounded to quarantined branches (see
          // evaluateModelApproveBound) — an ordinary PR based on trunk never
          // auto-merges from that path even once approved, so an approval can
          // sit unconsumed indefinitely with nothing retrying it. Re-check the
          // stored verdict on every CI-green event: a terminal approve above
          // the workspace's confidence threshold makes this PR self-mergeable
          // (the same authorization merge_pr's self-merge escape hatch uses),
          // so retry the merge here instead of leaving it to a poller that
          // does not exist.
          // An approval made before a rebase/base-merge still covers this head
          // when the PR diff is unchanged. The synchronize handler records that
          // too; repeating it here covers a lost push webhook.
          // Legacy path only (shadow/off): under `enforce` landPr runs this
          // carry-forward itself, before its verdict gate.
          if (pr.base?.ref) {
            await carryForwardApprovalIfUnchanged({
              installationId: installation.id,
              repoFullName: repository.full_name,
              workspaceId: workspace.id,
              prNumber: pr.number,
              baseRef: pr.base.ref,
              headSha,
            }).catch((err) => console.warn(`[review] carry-forward check failed for PR #${pr.number}:`, err));
          }
          const reviewStatus = await readPrReviewStatus({ workspaceId: workspace.id, prNumber: pr.number });
          const hasUnconsumedApprove =
            reviewStatus.state === 'approved' &&
            isApprovalSelfMergeable(
              { verdict: reviewStatus.verdict, confidence: reviewStatus.confidence, merged: reviewStatus.merged },
              policy.agentReview?.maxConfidenceThreshold,
            );

          if (!hasUnconsumedApprove) {
            console.log(`PR #${pr.number} on ${repository.full_name} awaiting agent review — deferring merge`);
            continue;
          }

          console.log(`PR #${pr.number} on ${repository.full_name}: unconsumed approve found on CI-green — retrying merge`);
          await tryAutoMergeWorkerPr({
            installationId: installation.id,
            repoFullName: repository.full_name,
            prNumber: pr.number,
            headSha,
            worker,
            policy,
            surfaceOrderingConfig: workspace.gitConfig ?? null,
          });
          continue;
        }

        // policy.tier === 'auto-threshold'
        await tryAutoMergeWorkerPr({
          installationId: installation.id,
          repoFullName: repository.full_name,
          prNumber: pr.number,
          headSha,
          worker,
          policy,
          surfaceOrderingConfig: workspace.gitConfig ?? null,
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
    title?: string;
    body?: string | null;
    merged: boolean;
    merged_at?: string | null;
    draft?: boolean;
    merge_commit_sha?: string | null;
    head: { ref: string; sha: string; repo?: { full_name: string } | null };
    base?: { ref: string; sha?: string };
    html_url: string;
    mergeable?: boolean | null;
  };
  installation?: { id: number };
  repository: { full_name: string; default_branch?: string };
  changes?: { base?: { ref?: { from?: string } } };
}) {
  const { action, pull_request: pr, repository } = event;
  if (action === 'opened' || action === 'reopened' || action === 'synchronize' || action === 'ready_for_review') {
    await registerLocalPr({ branch: pr.head.ref, repo: repository.full_name, headRepo: pr.head.repo?.full_name ?? null, number: pr.number,
      url: pr.html_url, headSha: pr.head.sha, baseRef: pr.base?.ref ?? null, draft: pr.draft ?? false });
  }

  // ── Keep workers.prBaseRef in step with GitHub's base ref ────────────────
  // Runs for EVERY pull_request action, before any action-specific branching,
  // because the action that matters most here is one none of the branches below
  // handle: `edited` with changes.base — a RETARGET. Somebody changing a PR's
  // base after it opened is precisely what makes the merge-policy decision
  // stale (a task PR moved off a mission integration branch onto trunk must get
  // its human gate back, and vice versa).
  //
  // Single atomic UPDATE with the no-op case excluded in the WHERE clause, so a
  // routine `synchronize` on an unchanged base costs no write. .returning() is
  // therefore also the retarget detector: a row comes back only on a real change.
  if (pr.base?.ref) {
    const observedBaseRef = pr.base.ref;
    try {
      // Read the prior base ref BEFORE the write below — `.returning()` on an
      // UPDATE only yields POST-update rows, and detecting a mission-gate
      // retarget (P2b) needs the value it moved FROM, not just that it moved.
      const retargetCandidate = await db.query.workers.findFirst({
        where: workerOwnsPr(repository.full_name, pr.number),
        columns: { id: true, workspaceId: true, taskId: true, prBaseRef: true },
        with: { task: { columns: { id: true, title: true, taskClass: true, missionId: true, context: true } } },
      });

      const rebased = await db
        .update(workers)
        .set({ prBaseRef: observedBaseRef, updatedAt: new Date() })
        .where(and(
          workerOwnsPr(repository.full_name, pr.number),
          or(isNull(workers.prBaseRef), ne(workers.prBaseRef, observedBaseRef)),
        ))
        .returning({ id: workers.id });
      // RETURNING yields post-update values, so the prior ref is not recoverable
      // here — the WHERE clause is what proves this was a change, not a no-op.
      for (const row of rebased) {
        console.log(
          `[webhook] PR #${pr.number} base ref now '${observedBaseRef}' `
          + `on worker ${row.id} [action=${action}]`,
        );
      }

      // A task PR (never the mission PR itself) whose base MOVED OFF its
      // mission's integration branch has lost its review gate. This is how
      // the production incident happened: a PR whose head was the
      // integration branch merged, the repo's delete-branch-on-merge setting
      // removed that branch, and GitHub silently retargeted every remaining
      // task PR of the mission to trunk. Loud, not absorbed — never handled
      // anywhere before this (no `base_ref_changed` / `automatic_base_change_
      // succeeded` handling existed at all).
      //
      // Two things changed once the other three doors started refusing. First,
      // the trigger no longer requires the PREVIOUS base to have been the
      // integration branch: `workers.prBaseRef` is null on every path that
      // deliberately declines to guess it, and requiring a known-good prior
      // value made the most common illegal shape — a PR that was never on the
      // integration branch at all — invisible. What matters is where the PR
      // points NOW. Second, buildd repairs rather than only reports: a webhook
      // cannot return 400 at anyone, so the enforcement form of "refused" here
      // is putting the base back. Reporting is what is left when it cannot.
      const retargetMissionId: string | null = retargetCandidate?.task?.missionId ?? null;
      // Where the PR's base ends up after this event — the observed ref, or the
      // integration branch when the guard below puts it back.
      let settledBaseRef = observedBaseRef;
      if (rebased.length > 0 && retargetMissionId && retargetCandidate?.task && !isMissionPrTask(retargetCandidate.task) && !pr.merged) {
        const task = retargetCandidate.task;
        const mission = await db.query.missions.findFirst({
          where: eq(missions.id, retargetMissionId),
          columns: { workingBranch: true, integrationBranchEnabled: true },
        });
        const guard = buildMissionBaseGuard({ mission, task, head: pr.head?.ref ?? null });
        if (guard.enforced && !guard.allows(observedBaseRef)) {
          const integrationBase = guard.integrationBase!;
          // A PR whose head IS the integration branch cannot be based on it —
          // GitHub rejects head === base. That shape is its own violation
          // (a task worker opening the mission PR's shape) and only the report
          // applies.
          const restorable = pr.head?.ref !== integrationBase && !!event.installation?.id;
          let restored = false;
          if (restorable) {
            try {
              await githubApi(
                event.installation!.id,
                `/repos/${repository.full_name}/pulls/${pr.number}`,
                {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ base: integrationBase }),
                },
              );
              restored = true;
              settledBaseRef = integrationBase;
              await db
                .update(workers)
                .set({ prBaseRef: integrationBase, updatedAt: new Date() })
                .where(workerOwnsPr(repository.full_name, pr.number));
              console.warn(
                `[webhook] PR #${pr.number} (mission ${retargetMissionId}) was based on `
                + `'${observedBaseRef}' — restored to integration branch '${integrationBase}'`,
              );
            } catch (err) {
              // Typically the integration branch no longer exists (the
              // production shape: it was deleted on merge and GitHub
              // auto-retargeted everything that pointed at it). Nothing to
              // restore to — fall through to the loud report.
              console.error(
                `[webhook] failed to restore PR #${pr.number} base to '${integrationBase}':`,
                err,
              );
            }
          }
          await reportMissionGateRetarget({
            missionId: retargetMissionId,
            taskTitle: task.title,
            prNumber: pr.number,
            prUrl: pr.html_url,
            headSha: pr.head?.sha ?? observedBaseRef,
            fromBase: integrationBase,
            toBase: observedBaseRef,
            restored,
          });
        }
      }

      // A retarget leaves the PR's change-intent rows naming the OLD base, so
      // surface ordering on the new base cannot see it as a contender and the
      // old lane keeps waiting on it. Move its open intents to where the PR now
      // lands and re-wake the head of both lanes (the wake only under ordering
      // `enforce`; the row update is cheap and always true). Workspace comes from
      // the repo-scoped worker that owns this PR. Never throws; network work in after().
      const retargetFrom = event.changes?.base?.ref?.from;
      const intentWorkspaceId = retargetCandidate?.workspaceId;
      if (
        action === 'edited' && typeof retargetFrom === 'string' && retargetFrom
        && retargetFrom !== settledBaseRef && !pr.merged && intentWorkspaceId
      ) {
        await emit({ type: 'pr.base_changed', workspaceId: intentWorkspaceId, prNumber: pr.number, fromBase: retargetFrom, toBase: settledBaseRef });
      }
    } catch (err) {
      // Never fail the webhook over bookkeeping — a missed sync self-heals on the
      // next pull_request event for this PR, and a null/stale value degrades to
      // the existing merge gate rather than skipping one.
      console.error(`[webhook] failed to sync prBaseRef for PR #${pr.number}:`, err);
    }
  }

  // Track PR lifecycle status and draft state on open/reopen/synchronize events
  if (
    !pr.merged &&
    (action === 'opened' || action === 'reopened' || action === 'ready_for_review' || action === 'synchronize' || action === 'converted_to_draft')
  ) {
    // A PR under an active request-changes retry loop can have more than one
    // worker row stamped with the same (prNumber, prUrl) — the original
    // worker and each retry ("attempt") task's own worker, since a retry
    // continues on the SAME branch/PR rather than opening a new one. Order by
    // newest so re-review dispatch (below) reads the retry's iteration
    // context, not the original task's stale one.
    const openWorker = await db.query.workers.findFirst({
      where: workerOwnsPr(repository.full_name, pr.number),
      columns: { id: true, workspaceId: true, taskId: true, branch: true },
      orderBy: [desc(workers.createdAt)],
    });
    if (openWorker) {
      // A fact for the fact cache (recordPrFact): mergeable=false is a
      // conflict (first-seen conflictDetectedAt), anything else is an open PR.
      // A late open-state event for a PR that already merged or closed changes
      // nothing (terminal wins, §16 S6); only `reopened` lifts a close.
      await recordPrFact(
        { workerId: openWorker.id },
        pr.mergeable === false ? { kind: 'conflict' } : { kind: 'open', reopened: action === 'reopened' },
        { bookkeeping: { prIsDraft: pr.draft ?? null } },
      );

      await triggerEvent(channels.workspace(openWorker.workspaceId), events.WORKER_PROGRESS, {
        taskId: openWorker.taskId,
      });

      // Reconcile the PR's claim scope against its actual diff at this head
      // (conflict-aware-orchestration §1): inherited fix-attempt manifests and
      // reviewer leases shrink to what the PR really touches. After the
      // response; a read at any other head is not trusted and changes nothing.
      if (event.installation && pr.head?.sha) {
        schedulePrScopeReconcile({
          workspaceId: openWorker.workspaceId,
          installationId: event.installation.id,
          repoFullName: repository.full_name,
          prNumber: pr.number,
          expectedHeadSha: pr.head.sha,
        });
      }

      // A push to a PR buildd owns: the reviews module notes it on the PR and,
      // after a non-approving verdict, re-dispatches a reviewer at the new head.
      if (event.installation && action === 'synchronize') {
        await emit({
          type: 'pr.synchronized',
          installationId: event.installation.id,
          repoFullName: repository.full_name,
          pr: { number: pr.number, headSha: pr.head.sha, htmlUrl: pr.html_url, baseRef: pr.base?.ref ?? null, body: pr.body ?? null, draft: !!pr.draft },
          worker: { id: openWorker.id, workspaceId: openWorker.workspaceId, taskId: openWorker.taskId ?? null, branch: openWorker.branch },
        });
      }
    }

    // A reopened PR the workflow kernel owns: T19 from a live read (a new round).
    if (event.installation && action === 'reopened' && openWorker?.workspaceId) {
      await observePrState({
        workspaceId: openWorker.workspaceId, repoFullName: repository.full_name, prNumber: pr.number,
        installationId: event.installation.id, source: 'webhook:reopened',
      }).catch((err) => console.error(`[webhook] workflow kernel reopen fact failed for PR #${pr.number}:`, err));
    }

    // On PR open (not synchronize/reopen): the PR-opened policy slot (reviews)
    // may take the PR (a reviewer dispatched, a human escalation, a mechanical
    // fix), and a PR it holds skips core's no-CI auto-merge below.
    if (!pr.draft && event.installation && action === 'opened' && openWorker?.taskId) {
      const { held } = await PR_OPENED_POLICY({
        installationId: event.installation.id,
        repoFullName: repository.full_name,
        pr: { number: pr.number, headSha: pr.head.sha, htmlUrl: pr.html_url, baseRef: pr.base?.ref ?? null, body: pr.body ?? null },
        worker: { id: openWorker.id, workspaceId: openWorker.workspaceId, taskId: openWorker.taskId, branch: openWorker.branch },
      });
      if (held) {
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
  // webhook.
  //
  // This after() call is the ONLY executor of diff jobs, so a lost background
  // run used to strand the job permanently. Durability now comes from the lease
  // taken by runDiffIngestJob: a run killed mid-flight leaves a lease that
  // lapses, and the next reclaim trigger (a runner claim poll, a manual enqueue,
  // or a redelivery of this same webhook) requeues it — enqueueMergedPrIngestJobs
  // returns reclaimed ids alongside newly inserted ones, so a redelivery
  // actually re-runs the lost job instead of being swallowed by the idempotency
  // index. Beyond the attempt ceiling the row is parked in `error` and the
  // file contents are recovered by an escalated full ingest.
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

  // Revert ledger: a merged PR whose title/body reverts another PR (or a
  // commit) holds that PR's candidate memories back from promotion.
  if (pr.merged) {
    await recordPrReverts({
      repoFullName: repository.full_name,
      revertedBy: `pr#${pr.number}`,
      revertingPrNumber: pr.number,
      text: [pr.title, pr.body].filter(Boolean).join('\n'),
    }).catch(err => console.error(`[webhook] recordPrReverts failed for PR #${pr.number} on ${repository.full_name}:`, err));
  }

  // Dark-check detection: track required checks that consistently report
  // 'skipped', alerting the workspace owner when N consecutive PRs show the
  // pattern. Fire-and-forget — never blocks the webhook response path.
  // Needs the base branch: only the checks that branch requires can be dark.
  if (event.installation && pr.base?.ref) {
    detectDarkChecksForClosedPr(
      event.installation.id,
      repository.full_name,
      pr.head.sha,
      pr.base.ref,
    ).catch(e =>
      console.error(`[webhook] dark-check detection failed for ${repository.full_name}:`, e),
    );
  }

  // Strategy 1: Match by prNumber on workers table (agent-created PRs)
  const worker = await db.query.workers.findFirst({
    where: workerOwnsPr(repository.full_name, pr.number),
    with: { task: true },
  });

  // The workflow kernel records the close as a fact on a kernel-owned PR
  // (T17 / T18, from a live read). For a merge, everything the merge owes runs
  // as the kernel's post-merge effects (stamp_pr_rows, emit_pr_merged,
  // finalize_mission_pr) from that transition, not from this request.
  let kernelOwned = false;
  if (worker?.workspaceId && event.installation) {
    kernelOwned = await observePrState({
      workspaceId: worker.workspaceId, repoFullName: repository.full_name, prNumber: pr.number,
      installationId: event.installation.id, source: 'webhook:closed',
    }).catch((err) => {
      console.error(`[webhook] workflow kernel close fact failed for PR #${pr.number}:`, err);
      return false;
    });
  }

  // Is this handler LEARNING about the merge, or is it a redelivery of one it
  // already processed? Captured from the row read before any stamp, and it is
  // what keeps the per-merge effects exactly-once now that they no longer ride
  // on the task's status transition.
  const mergeIsNew = !worker?.mergedAt;

  // Subscriptions ledger: any merged PR, buildd-opened or not. Idempotent on
  // the dedupe key, so a redelivery or the reconcile sweep writes nothing new.
  // The releases module also records a merge into a prod branch here, whether
  // or not a worker owns the PR, on every delivery (idempotent on headSha).
  if (pr.merged && pr.base?.ref && event.installation) {
    const installationId = event.installation.id;
    const baseRef = pr.base.ref;
    scheduleBaseAdvanceNotice(`PR #${pr.number} ${repository.full_name}`, async () => ({
      repoFullName: repository.full_name, baseRef, defaultBranch: repository.default_branch ?? null,
      files: await changedFilesForPr(installationId, repository.full_name, pr.number),
      source: 'pull_request',
      change: { prNumber: pr.number, title: pr.title ?? null, sha: pr.merge_commit_sha ?? pr.head.sha, authorBranch: pr.head.ref },
    }));
  }

  if (pr.merged) {
    await emit({
      type: 'pr.merged', repoFullName: repository.full_name, prNumber: pr.number, url: pr.html_url,
      delivery: {
        installationId: event.installation?.id ?? null,
        baseRef: pr.base?.ref ?? null,
        baseSha: pr.base?.sha ?? null,
        headSha: pr.head.sha,
        mergeCommitSha: pr.merge_commit_sha ?? null,
        title: pr.title ?? null,
      },
    });
  }

  // Every close delivery: the reviews module resolves the sticky activity
  // comment and tells an on-demand review waiting on this PR that it closed.
  await emit({
    type: 'pr.close_delivered',
    repoFullName: repository.full_name,
    prNumber: pr.number,
    merged: !!pr.merged,
    baseRef: pr.base?.ref ?? null,
    installationId: event.installation?.id ?? null,
    workspaceId: worker?.workspaceId ?? null,
  });

  if (worker && pr.merged) {
    // A merged doc fix gets its conformance re-run now, not whenever the
    // next dev push happens to evaluate the doc (spec-conformance.md §9).
    // Best-effort; the hourly pr-reconcile sweep is the backstop.
    if (worker.taskId) {
      const docFixTaskId = worker.taskId;
      const recheck = () => requestRecheckForMergedDocFix(docFixTaskId).catch(e =>
        console.error(`[webhook] spec recheck dispatch failed for task ${docFixTaskId}:`, e),
      );
      try {
        after(recheck);
      } catch {
        await recheck();
      }
    }
    // A kernel-owned merge's work already ran (or is durably owed) as effects of T17.
    if (!kernelOwned) {
      await runMergedPrWork({
        worker: { id: worker.id, workspaceId: worker.workspaceId, taskId: worker.taskId ?? null },
        task: worker.task
          ? {
              id: worker.task.id,
              status: worker.task.status,
              workspaceId: worker.task.workspaceId,
              missionId: worker.task.missionId ?? null,
              taskClass: worker.task.taskClass ?? null,
              release: worker.task.release ?? null,
              loopState: worker.task.loopState ?? null,
            }
          : null,
        repoFullName: repository.full_name,
        prNumber: pr.number,
        prUrl: prUrlFor(repository.full_name, pr.number),
        prHtmlUrl: pr.html_url,
        baseRef: pr.base?.ref ?? null,
        headSha: pr.head.sha,
        installationId: event.installation?.id ?? null,
        // GitHub's clock, not receipt time (§12).
        mergedAt: pr.merged_at ?? new Date(),
        mergeIsNew,
        stamp: true,
      });
    }
    // A worker row with no task falls through to the branch-name match below.
    if (worker.task) return;
  }

  if (worker && !pr.merged) {
    // PR closed without merge (abandoned/superseded): every row carrying the
    // PR, never over a merge (recordPrFact).
    await recordPrFact({ prUrl: prUrlFor(repository.full_name, pr.number), prNumber: pr.number }, { kind: 'closed' });
    await triggerEvent(channels.workspace(worker.workspaceId), events.WORKER_PROGRESS, {
      taskId: worker.taskId,
    });

    // The task's file edits are abandoned: held path claims unblock waiting tasks.
    if (worker.taskId) {
      const releaseTaskId = worker.taskId;
      // after(): delivery is now N DB writes (one message per waiter), not one
      // Pusher call, so an unawaited promise can be cut off when the response
      // returns — and `notifiedAt` is already stamped by then.
      try {
        after(() => releaseAndNotify(releaseTaskId, 'abandoned').catch(e =>
          console.error(`[webhook] releaseAndNotify failed for task ${releaseTaskId}:`, e),
        ));
      } catch {
        // Outside a request scope (tests, direct invocation) — run inline.
        await releaseAndNotify(releaseTaskId, 'abandoned').catch(e =>
          console.error(`[webhook] releaseAndNotify failed for task ${releaseTaskId}:`, e),
        );
      }
    }

    // Close any open changeIntent rows for this PR, drop its merge
    // reservations and re-drive the PR waiting behind it (missions). Then the
    // reviews module looks for where the unmerged PR's work went, cancels what
    // the close made obsolete, and shuts down superseded buildd PRs.
    await emit({
      type: 'pr.closed',
      workspaceId: worker.workspaceId,
      prNumber: pr.number,
      merged: false,
      mergeIsNew: false,
      workerId: worker.id,
      taskId: worker.taskId ?? null,
      headSha: pr.head.sha,
      repoFullName: repository.full_name,
      installationId: event.installation?.id ?? null,
    });
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
      // Same rule as runMergedPrWork: a task with other open PRs is not done.
      const openSiblingPrs = await otherOpenPrsOfTask(matchingTask.id, { prUrl: prUrlFor(repository.full_name, pr.number) });
      if (openSiblingPrs.length > 0) return;
      // Row-guarded for the same reason as the worker-match path above.
      const [flipped] = await db
        .update(tasks)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(and(eq(tasks.id, matchingTask.id), ne(tasks.status, 'completed')))
        .returning({ id: tasks.id });
      if (!flipped) return;
      console.log(`Auto-completed task ${matchingTask.id} via branch match on merged PR #${pr.number}`);

      await emit({
        type: 'task.pr_merged',
        via: 'branch_match',
        transition: 'flipped',
        taskClass: matchingTask.taskClass ?? null,
        taskId: matchingTask.id,
        workerId: null,
        workspaceId: matchingTask.workspaceId,
        missionId: matchingTask.missionId ?? null,
        release: matchingTask.release ?? null,
        repoFullName: repository.full_name,
        baseRef: pr.base?.ref ?? null,
        installationId: event.installation?.id ?? null,
      });

      // Dependents, mission completion and re-planning, as for any completion.
      await resolveCompletedTask(matchingTask.id, matchingTask.workspaceId).catch(e =>
        console.error(`[webhook] resolveCompletedTask failed for branch-matched task ${matchingTask.id}:`, e),
      );
      await detachInteractiveWorkersOfEndedTasks({ taskId: matchingTask.id, graceMs: 0 });
    }
  }
}

/**
 * A task PR is based somewhere other than its mission's integration branch
 * (P2b) — a lost review gate, reported loudly rather than absorbed.
 *
 * `restored` says whether buildd already put the base back. Both outcomes are
 * reported: a silent repair would hide the fact that something opened or moved
 * a mission task PR onto trunk, which is the signal worth having. Best-effort —
 * a failure here must never fail the webhook, and the observation itself
 * already persisted (`workers.prBaseRef`) either way.
 */
async function reportMissionGateRetarget(opts: {
  missionId: string;
  taskTitle: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  fromBase: string;
  toBase: string;
  restored?: boolean;
}): Promise<void> {
  const message = opts.restored
    ? `${opts.taskTitle} — PR #${opts.prNumber} was based on \`${opts.toBase}\` instead of this ` +
      `mission's integration branch (\`${opts.fromBase}\`). buildd retargeted it back to ` +
      `\`${opts.fromBase}\`, so the mission review gate is intact. Worth knowing how it got ` +
      `there: every path that opens or adopts a task PR is supposed to refuse this base.`
    : `${opts.taskTitle} — PR #${opts.prNumber}'s base is \`${opts.toBase}\`, not the mission's ` +
      `integration branch (\`${opts.fromBase}\`), and buildd could not restore it — the ` +
      `integration branch has most likely been deleted. This PR has lost its mission review ` +
      `gate. Re-point it deliberately or route it through the mission PR.`;
  try {
    await db.insert(missionNotes).values({
      missionId: opts.missionId,
      authorType: 'system',
      type: 'warning',
      title: opts.restored
        ? `PR #${opts.prNumber} was restored to the mission integration branch`
        : `PR #${opts.prNumber} lost its mission integration gate`,
      body: message,
      status: 'open',
    });
  } catch (err) {
    console.error(`[webhook] failed to record gate-retarget note for PR #${opts.prNumber}:`, err);
  }
  await emit({
    type: 'pr.needs_human',
    missionId: opts.missionId,
    title: opts.restored
      ? `PR #${opts.prNumber} restored to the mission integration branch`
      : `PR #${opts.prNumber} retargeted off the mission integration branch`,
    prUrl: opts.prUrl,
    prNumber: opts.prNumber,
    headSha: opts.headSha,
    reason: 'base_retargeted',
    message,
  });
  console.error(
    `[webhook] PR #${opts.prNumber} (mission ${opts.missionId}) based on '${opts.toBase}' `
    + `instead of integration branch '${opts.fromBase}' — `
    + (opts.restored ? 'base restored by buildd' : 'review gate lost'),
  );
}

// For a newly-opened worker PR on a repo with no CI, attempt auto-merge now.
// Repos that DO have CI are skipped here and handled by the check_suite path
// once checks go green.
async function maybeAutoMergeNoCiPr(
  installationId: number,
  repoFullName: string,
  pr: { number: number; head: { sha: string }; base?: { ref: string } },
): Promise<void> {
  const linkedWorkspaces = await db.query.workspaces.findMany({
    where: workspaceRepoMatches(repoFullName),
  });

  for (const workspace of linkedWorkspaces) {
    // Only auto-merge PRs created by a Buildd worker in this workspace.
    const worker = await db.query.workers.findFirst({
      where: and(
        eq(workers.workspaceId, workspace.id),
        workerOwnsPr(repoFullName, pr.number),
      ),
    });
    if (!worker) {
      continue;
    }

    // Resolve merge policy with task/mission context
    let workerTask: { requiresReview: boolean; mission: { mergePolicy?: import('@buildd/shared').MergePolicy | null; requiresReview: boolean; workingBranch: string | null; integrationBranchEnabled: boolean } | null } | undefined;
    if (worker.taskId) {
      workerTask = await db.query.tasks.findFirst({
        where: eq(tasks.id, worker.taskId),
        with: { mission: { columns: { mergePolicy: true, requiresReview: true, workingBranch: true, integrationBranchEnabled: true } } },
        columns: { id: true, requiresReview: true },
      }) as typeof workerTask;
    }
    // Prefer the webhook payload's base ref (authoritative, no race with the
    // create-PR write); fall back to the recorded column when this handler is
    // reached from a path that carries no base.
    const policy = resolvePolicy(
      workspace,
      workerTask?.mission ?? null,
      workerTask ?? null,
      { baseRef: pr.base?.ref ?? worker.prBaseRef },
    );

    if (policy.tier !== 'auto-threshold') {
      // 'human': surface in escalation inbox (notification fired by check_suite or PR open handler)
      // 'agent-review': reviewer was dispatched on PR open; it will trigger merge on approve
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
      policy,
      surfaceOrderingConfig: workspace.gitConfig ?? null,
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

  // A delayed success must not authorize a newer commit. Leave the pending
  // release for its own CI event if the head moved or cannot be verified.
  try {
    const livePr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
    if (!headSha || livePr?.head?.sha !== headSha) return;
  } catch (error) {
    console.warn(`[release-pr] Could not verify live head for ${repoFullName}#${prNumber}:`, error);
    return;
  }

  // Verify ALL check suites passed before merging (not just this one).
  const allPassed = await allCheckSuitesPassed(installationId, repoFullName, headSha);
  if (!allPassed) {
    console.log(`[release-pr] Not all suites passed for ${repoFullName}#${prNumber} — waiting for remaining checks`);
    return;
  }

  // Release promotion is a merge door like any other. buildd never dispatches a
  // reviewer for a release PR on its own, so the gate normally reads
  // `not_requested` and passes — but `request_pr_review` can be pointed at any
  // PR, and a release that ships past its own reviewer's finding is the one
  // merge where that matters most.
  const releaseGate = await guardReviewVerdict({
    workspaceId: pendingReleaseTasks[0]!.workspaceId,
    prNumber,
    headSha,
    surface: 'release-pr ci-success',
    taskId: pendingReleaseTasks[0]!.id,
    callerOrigin: 'system',
  });
  if (releaseGate.blocks) {
    console.log(
      `[release-pr] Merge of ${repoFullName}#${prNumber} held: ${releaseGate.reason}. ${releaseGate.clearedBy}`,
    );
    fireGateEvent({
      gate: GATE_SLUGS.REVIEW_VERDICT,
      surface: 'release-pr ci-success',
      outcome: 'deferred',
      reason: releaseGate.reason ?? 'review verdict blocks this merge',
      workspaceId: pendingReleaseTasks[0]!.workspaceId,
      taskId: pendingReleaseTasks[0]!.id,
      callerOrigin: 'system',
      detail: {
        prNumber,
        headSha,
        reviewState: releaseGate.state ?? null,
        reviewKind: releaseGate.kind ?? null,
      },
    });
    return;
  }

  const mergeResult = await mergePullRequest(installationId, repoFullName, prNumber, 'merge', headSha);

  for (const task of pendingReleaseTasks) {
    const ctx = (task.context ?? {}) as Record<string, unknown>;
    const prUrl = ctx.releasePrUrl as string | undefined;

    if (mergeResult.merged) {
      const releaseResult = {
        status: 'completed' as const,
        message: `Release: completed — PR #${prNumber} merged to ${repoFullName}`,
        mergedAt: new Date().toISOString(), // pr-fact-guard: not a workers write (release task result)
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
      await emitHeldReleaseOutcome(task.id, null);
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

      void notifyTeamOf({ taskId: task.id }, 'needsAttention', {
        title: `Release merge failed — ${repoFullName}#${prNumber}`,
        message: errMsg,
        priority: 1,
        url: prUrl || `https://github.com/${repoFullName}/pull/${prNumber}`,
        urlTitle: 'Open PR',
      });
      console.error(`[release-pr] Task ${task.id} FAILED: merge of PR #${prNumber} rejected: ${errMsg}`);
      await emitHeldReleaseOutcome(task.id, { slot: 'release', label: 'Release merge failed', reason: errMsg });
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

      void notifyTeamOf({ taskId: task.id }, 'needsAttention', {
        title: `Release CI failed — ${repoFullName}#${pr.number}`,
        message: `CI is red on release PR #${pr.number}. Prod has NOT shipped.`,
        priority: 1,
        url: prUrl || `https://github.com/${repoFullName}/pull/${pr.number}`,
        urlTitle: 'Open PR',
      });
      console.error(`[release-pr] Task ${task.id} FAILED: CI failed on release PR #${pr.number}`);
      await emitHeldReleaseOutcome(task.id, { slot: 'release', label: 'Release CI failed', reason: releaseResult.error });
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
/** A branch is the repo's default one; unknown (no default in the payload) counts as yes. */
function isDefaultBranch(branch: string | null | undefined, defaultBranch: string | undefined): boolean {
  if (!branch) return false;
  return !defaultBranch || branch === defaultBranch;
}

/**
 * Tell live workers whose base just moved under files they are editing
 * (lib/base-advance-notice.ts). File listing can need a GitHub call, so the
 * whole thing runs in after(); it never fails the webhook.
 */
const BASE_RESOLVER: BaseResolver = {
  taskPrBase: args => resolveTaskPrBase(args).base,
  looksLikeIntegrationBranch: looksLikeMissionIntegrationBranch,
};

function scheduleBaseAdvanceNotice(
  label: string,
  build: () => Promise<BaseAdvanceInput | null>,
): void {
  const run = () => build()
    .then(input => (input ? runBaseAdvanceNotice(input, BASE_RESOLVER) : null))
    .catch(err => console.error(`[base-advance] ${label} failed:`, err));
  try {
    after(run);
  } catch {
    // after() is unavailable outside a request scope (tests) — run inline, unawaited.
    void run();
  }
}

/**
 * `push` to the default branch does two things:
 *  - commit messages go to the revert ledger (a `git revert` of a merge commit
 *    names its sha);
 *  - docs files the push touched are ingested into the bound workspaces' `docs`
 *    corpus, so a repo that is committed to directly (no merged PR) stays
 *    searchable. See enqueuePushIngestJobs in lib/knowledge-ingest.ts.
 *
 * Inert unless the GitHub App subscribes to push events; the push-triggered
 * workflow_run still covers the head commit for the revert ledger either way.
 */
async function handlePushEvent(event: {
  ref?: string;
  before?: string;
  after?: string;
  deleted?: boolean;
  size?: number;
  repository?: { full_name?: string; default_branch?: string };
  installation?: { id: number };
  commits?: Array<{ id?: string; message?: string; added?: string[]; modified?: string[]; removed?: string[] }>;
  head_commit?: { message?: string } | null;
}): Promise<void> {
  // A push to the private prompts repo scores the pushed text that changed (lib/prompt-evals/run.ts).
  // Network + model work, so after(); never fails the webhook.
  const promptEvalRef = promptEvalRefForPush(event);
  if (promptEvalRef) {
    try {
      after(() =>
        runPromptEval({ trigger: 'push', ref: promptEvalRef }, promptEvalDeps())
          .then(out => console.log(`[prompt-evals] push ${promptEvalRef.slice(0, 7)}: ${out.status}`))
          .catch(err => console.error('[prompt-evals] push eval failed:', err instanceof Error ? err.message : String(err))),
      );
    } catch (err) {
      console.warn('[prompt-evals] after() unavailable; this push is not scored (run POST /api/admin/prompt-evals):', err);
    }
  }

  const repo = event.repository?.full_name;
  const branch = event.ref?.startsWith('refs/heads/') ? event.ref.slice('refs/heads/'.length) : null;

  // Base-advance notice: any branch a live worker could be based on — trunk
  // AND mission integration branches, so this runs before the default-branch
  // return below. A merged PR also arrives as pull_request.closed; the
  // per-worker debounce folds the pair into one message.
  if (repo && isPossibleBaseRef(branch) && !event.deleted) {
    const commits = event.commits ?? [];
    const authors = authorsFromPushCommits(commits);
    const installationId = event.installation?.id;
    scheduleBaseAdvanceNotice(`push ${repo}@${branch}`, async () => {
      let files = changedFilesFromPush(commits);
      // GitHub lists at most 20 commits in a push payload; past that, compare.
      const truncated = (event.size ?? commits.length) > commits.length;
      if ((truncated || files.length === 0) && installationId && event.before && event.after
        && !/^0+$/.test(event.before)) {
        files = await changedFilesForCompare(installationId, repo, event.before, event.after).catch(() => files);
      }
      return {
        repoFullName: repo, baseRef: branch, defaultBranch: event.repository?.default_branch ?? null,
        files, source: 'push',
        change: {
          sha: event.after ?? null,
          authorPrNumbers: authors.prNumbers,
          authorBranches: authors.branches,
          ...(authors.prNumbers.length === 1 ? { prNumber: authors.prNumbers[0] } : {}),
        },
      };
    });
  }

  if (!repo || !isDefaultBranch(branch, event.repository?.default_branch)) return;
  for (const c of event.commits ?? []) {
    if (!c.id || !c.message) continue;
    await recordPrReverts({ repoFullName: repo, revertedBy: c.id, text: c.message })
      .catch(err => console.error(`[webhook] recordPrReverts failed for ${c.id} on ${repo}:`, err));
  }

  // Best-effort, like the merged-PR enqueue: never fails the webhook. The jobs
  // run in after(); a lost run is reclaimed through the lease (see the
  // pull_request handler's note on durability).
  try {
    const { jobIds } = await enqueuePushIngestJobs({
      repoFullName: repo,
      after: event.after ?? '',
      size: event.size,
      commits: event.commits ?? [],
      headCommitMessage: event.head_commit?.message ?? event.commits?.at(-1)?.message ?? null,
      deleted: event.deleted,
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
        console.warn('[knowledge-ingest] after() unavailable; jobs remain queued:', err);
      }
    }
  } catch (err) {
    console.error('[knowledge-ingest] push enqueue failed (non-fatal):', err);
  }
}

async function handleWorkflowRunEvent(event: {
  action: string;
  workflow_run: {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    html_url: string;
    head_branch: string | null;
    head_sha: string;
    event?: string;
    path?: string;
    head_commit?: { id?: string; message?: string } | null;
    repository: { full_name: string };
  };
  repository?: { full_name: string; default_branch?: string };
  installation?: { id: number };
}): Promise<void> {
  if (event.action !== 'completed') return;

  const run = event.workflow_run;

  // Revert ledger: CI runs on every push to the default branch, so its head
  // commit is how a revert pushed there (directly, or as a squashed revert PR)
  // reaches us without a push-event subscription.
  if (run.event === 'push' && run.head_commit?.message && isDefaultBranch(run.head_branch, event.repository?.default_branch)) {
    await recordPrReverts({
      repoFullName: run.repository.full_name,
      revertedBy: run.head_commit.id ?? run.head_sha,
      text: run.head_commit.message,
    }).catch(err => console.error(`[webhook] recordPrReverts failed for run ${run.id}:`, err));
  }

  // Read the run back into its release row and the task that dispatched it:
  // the releases module's business.
  await emit({ type: 'workflow_run.completed', run, installationId: event.installation?.id ?? null });
}

/** Resolve the worker that owns a PR, plus the workspace the row needs. */
async function resolvePrOwner(repoFullName: string, prNumber: number) {
  return db.query.workers.findFirst({
    where: workerOwnsPr(repoFullName, prNumber),
    columns: { id: true, taskId: true, workspaceId: true },
    with: { task: { columns: { id: true, title: true, missionId: true } } },
  });
}

/** The owner fact a review event carries. */
function ownerFact(w: Awaited<ReturnType<typeof resolvePrOwner>>): PrOwnerFact | null {
  if (!w) return null;
  return { workerId: w.id, taskId: w.taskId ?? null, workspaceId: w.workspaceId ?? null, missionId: w.task?.missionId ?? null };
}

/**
 * Inline review comments — `pull_request_review_comment`. Only `created`:
 * an edit or delete mutates a comment already captured. The reviews module
 * captures it for retrieval by the file it concerns.
 */
async function handlePullRequestReviewCommentEvent(event: any): Promise<void> {
  const comment = event?.comment;
  const pr = event?.pull_request;
  const repository = event?.repository;
  if (event?.action !== 'created') return;
  if (!comment || !pr?.number || !repository?.full_name) return;

  const owner = await resolvePrOwner(repository.full_name, pr.number);
  if (!owner?.workspaceId) return;
  await emit({ type: 'pr.review_comment_created', repoFullName: repository.full_name, prNumber: pr.number, comment, owner: ownerFact(owner) });
}

/**
 * `pull_request_review`, `submitted` only: the action that carries a verdict.
 * The reviews module captures the text and records a person's verdict on a
 * mission PR. Neither merges, completes a task, nor clears buildd's review
 * gate: whether a GitHub approval should is a policy question.
 */
async function handlePullRequestReviewEvent(event: any): Promise<void> {
  const review = event?.review;
  const pr = event?.pull_request;
  const repository = event?.repository;
  if (event?.action !== 'submitted') return;
  if (!review || !pr?.number || !repository?.full_name) return;

  const owner = await resolvePrOwner(repository.full_name, pr.number);
  await emit({ type: 'pr.review_submitted', repoFullName: repository.full_name, prNumber: pr.number, review, owner: ownerFact(owner) });
}
