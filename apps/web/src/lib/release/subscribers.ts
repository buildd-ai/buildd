/**
 * Releases module: what a merge and a finished workflow run mean for releases.
 * Core (the GitHub webhook) emits the facts (lib/core-events.ts); this module
 * owns the reaction. Order and the composition root: apps/web/src/modules.ts.
 *
 * - `pr.merged` (webhook delivery only): a merge into a workspace's prod
 *   branch is recorded as a release, and a gated release advances, whether or
 *   not a worker owns the PR. Every delivery, fire-and-forget: both writes are
 *   idempotent on the head sha, so a redelivery records nothing new.
 * - `task.pr_merged` (once per merge, worker-owned PRs): Path B, the
 *   webhook-side release trigger for workflow_dispatch workspaces.
 * - `workflow_run.completed`: the release row's state, and the release record
 *   of the task that dispatched the run.
 */
import { db } from '@buildd/core/db';
import { tasks, workspaces, missions, releases } from '@buildd/core/db/schema';
import type { ReleaseResult } from '@buildd/core/db/schema';
import { and, eq, sql, inArray, isNull, desc } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { isMissionIntegrationBase } from '@buildd/core/mission-integration';
import { resolveReleaseStrategy, resolveReleaseTrigger } from '@buildd/core/release-strategy';
import {
  countPendingTasksForMission,
  claimMissionReleaseAttempt,
  abandonMissionReleaseAttempt,
  recordDispatchedRelease,
} from '@/lib/mission-release';
import { canCompleteMission } from '@/lib/mission-completion';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { notifyTeamOf } from '@/lib/notify';
import { recordAndDispatchRelease } from '@/lib/release/record';
import { detectArchetype } from '@buildd/core/release-archetype';
import { buildWorkflowRunOutcome, isConfiguredReleaseRun, mapWorkflowConclusionToReleaseState } from '@/lib/release/workflow-run';
import { verifyReleaseDeployment } from '@/lib/release-verification';
import { recordDirectProdMerge, advanceGatedReleaseOnPrMerge } from '@/lib/release-executor';
import { subscriber, type AnySubscriber, type EventOf, type WorkflowRunFact } from '@/lib/core-events';

function recordProdMerge(e: EventOf<'pr.merged'>): void {
  const d = e.delivery;
  if (!d || d.installationId == null || !d.baseRef) return;
  const pr = { number: e.prNumber };
  const repository = { full_name: e.repoFullName };
  // Record a `releases` row for a merge into a workspace's configured prod
  // branch, regardless of whether a buildd worker owns this PR. The release
  // PR (dev → prod) and hotfix PR (feature → prod) that ship this repo are
  // opened by a release script via the `gh` CLI and merged by CI/a human —
  // no worker ever owns either PR, so the worker-scoped release recording
  // never runs for them. Idempotent on (workspaceId, headSha), so this
  // is a no-op when a worker-owned merge already recorded the same headSha.
  recordDirectProdMerge({
    repoFullName: repository.full_name,
    installationId: d.installationId,
    baseRef: d.baseRef,
    headSha: d.mergeCommitSha ?? undefined,
    previousSha: d.baseSha ?? undefined,
  }).catch(err =>
    console.error(`[webhook] recordDirectProdMerge failed for PR #${pr.number} on ${repository.full_name}:`, err),
  );

  // A `gated` + `workflow_dispatch` workspace's release PR merging into
  // prodBranch is its only real deploy signal — recordDirectProdMerge above
  // is a no-op for it (branch_merge strategy only). Advance the release row
  // already recorded at dispatch time, or record the merge as its own
  // release when no dispatched row shipped in it (hotfix, direct merge).
  advanceGatedReleaseOnPrMerge({
    repoFullName: repository.full_name,
    baseRef: d.baseRef,
    prHeadSha: d.headSha,
    installationId: d.installationId,
    mergeCommitSha: d.mergeCommitSha,
    baseSha: d.baseSha,
    prTitle: d.title,
    prNumber: pr.number,
  }).catch(err =>
    console.error(`[webhook] advanceGatedReleaseOnPrMerge failed for PR #${pr.number} on ${repository.full_name}:`, err),
  );
}

async function releaseOnTaskPrMerge(e: EventOf<'task.pr_merged'>): Promise<void> {
  // Path B has only ever run for a worker-owned PR.
  if (e.via !== 'worker') return;
  const { repoFullName, baseRef, installationId } = e;
  const mergedTask = { id: e.taskId, workspaceId: e.workspaceId, missionId: e.missionId, release: e.release };
  // Post-merge release trigger — Path B (webhook side).
  //
  // Invariant enforced here:
  //   branch_merge workspaces → Path A (worker PATCH + executeRelease) is authoritative.
  //                              Path B must NOT fire to prevent double-fire.
  //   workflow_dispatch workspaces → Path A skips; Path B fires the workflow.
  //   trigger=manual → neither path auto-fires.
  //   trigger=on_mission_complete → only fire when mission is all-terminal + atomic dedup.
  //
  // Option A′ adds one more: a merge into a mission integration branch is NOT
  // a release-triggering merge. `workflow_dispatch` does not go through
  // `executeRelease` (which refuses this case itself), so without this guard a
  // mission whose last task PR landed on the integration branch would dispatch
  // a release of trunk — a release recorded against the mission that does not
  // contain the mission's work. That is the same class of lie as a mission
  // marked released with nothing deployed.
  // The authoritative predicate, not the `mission/` name heuristic: a mission
  // that has NOT opted in must behave exactly as before, even if its branch
  // happens to carry that prefix. Costs one two-column read, and only for a
  // mission task on a merged PR.
  const mergedTaskMission = mergedTask.missionId
    ? await db.query.missions.findFirst({
        where: eq(missions.id, mergedTask.missionId),
        columns: { workingBranch: true, integrationBranchEnabled: true },
      })
    : null;
  const mergedOntoIntegrationBranch = isMissionIntegrationBase({
    baseRef: baseRef,
    mission: mergedTaskMission,
  });
  if (mergedTask.release !== 'false' && installationId != null && !mergedOntoIntegrationBranch) {
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
          const trigger = resolveReleaseTrigger(releaseConfig);

          if (trigger === 'manual') {
            // no-op: owner fires trigger_release manually
          } else if (trigger === 'on_mission_complete') {
            // Only dispatch if this task's mission is now all-terminal
            if (mergedTask.missionId) {
              const missionId = mergedTask.missionId;
              const pending = await countPendingTasksForMission(missionId);
              if (pending === 0) {
                // Same predicate as every other completion path, including the
                // goal-criteria gate. This side used to check only "no pending
                // tasks" and dispatch, so a mission whose criteria read `fail`
                // could be shipped here and refused by the completion path in
                // the same minute. `evaluateCriteria: false` — a release READS a
                // verdict, it does not manufacture one.
                const decision = await canCompleteMission(missionId, {
                  path: 'release_trigger',
                  acceptCompleted: true,
                  evaluateCriteria: false,
                });
                if (!decision.ok) {
                  console.log(
                    `[webhook] mission ${missionId}: not releasing — ${decision.code}: ${decision.reason}`,
                  );
                } else if (await claimMissionReleaseAttempt(missionId)) {
                  // Phase 1 claimed the ATTEMPT. Both exits below resolve it.
                  const { workflowFile, ref, inputs } = resolution.strategy;
                  const [owner, name] = repoFullName.split('/');
                  // Only the dispatch itself belongs in this try. Everything
                  // after it is bookkeeping for a release that HAS gone out:
                  // reporting `dispatch_failed` for a failed write claims prod
                  // did not ship when it did, and handing the claim back frees
                  // the next merge in this mission to dispatch a SECOND
                  // release. See recordDispatchedRelease in lib/mission-release.
                  const recorded = await recordAndDispatchRelease({
                    workspaceId: mergedTask.workspaceId,
                    archetype: detectArchetype({
                      name: mergedWorkspace.name,
                      releaseConfig: mergedWorkspace.releaseConfig,
                      gitConfig: mergedWorkspace.gitConfig,
                    }),
                    installationId: installationId,
                    owner,
                    name,
                    repoFullName: repoFullName,
                    workflowFile,
                    ref,
                    prodBranch: releaseConfig?.prodBranch ?? mergedWorkspace.gitConfig?.defaultBranch ?? 'main',
                    inputs: { force: 'false', ...inputs },
                    triggeredBy: 'auto',
                  });

                  if (!recorded.ok) {
                    await abandonMissionReleaseAttempt(
                      missionId,
                      'dispatch_failed',
                      `Dispatching ${workflowFile}@${ref} for ${repoFullName} failed: ${recorded.error}`,
                    );
                  } else {
                    console.log(`[webhook] Mission ${missionId} complete — dispatched ${workflowFile}@${ref} for ${repoFullName} (release=${recorded.releaseId}, runId=${recorded.runId ?? 'pending'})`);
                    await recordDispatchedRelease(missionId, `${workflowFile}@${ref}`);

                    const releaseResult: ReleaseResult = {
                      status: 'pending_ci',
                      message: `Release: dispatched ${workflowFile}@${ref} for mission ${missionId} — awaiting workflow completion`,
                      runId: recorded.runId,
                      runUrl: recorded.runUrl,
                      releaseId: recorded.releaseId,
                    };
                    try {
                      await db
                        .update(tasks)
                        .set({ releaseResult, updatedAt: new Date() })
                        .where(eq(tasks.id, mergedTask.id));
                    } catch (err) {
                      console.error(`[webhook] Mission ${missionId}: dispatched ${workflowFile}@${ref} but could not annotate task ${mergedTask.id}:`, err);
                    }
                  }
                }
              }
            }
          } else {
            // every_merge (or future values): dispatch on each merged PR.
            //
            // Goes through recordAndDispatchRelease so this dispatch leaves
            // a `releases` row. It used to write only tasks.releaseResult,
            // and because every automatic path into maybeCreateReleaseRow
            // filters on strategy branch_merge first, a gated +
            // workflow_dispatch workspace could never get a row at all —
            // the Releases page, the queue baseline and the health cron
            // were blind to every release that actually shipped.
            const { workflowFile, ref, inputs } = resolution.strategy;
            const [owner, name] = repoFullName.split('/');
            const recorded = await recordAndDispatchRelease({
              workspaceId: mergedTask.workspaceId,
              archetype: detectArchetype({
                name: mergedWorkspace.name,
                releaseConfig: mergedWorkspace.releaseConfig,
                gitConfig: mergedWorkspace.gitConfig,
              }),
              installationId: installationId,
              owner,
              name,
              repoFullName: repoFullName,
              workflowFile,
              ref,
              prodBranch: releaseConfig?.prodBranch ?? mergedWorkspace.gitConfig?.defaultBranch ?? 'main',
              inputs: { force: 'false', ...inputs },
              triggeredBy: 'auto',
            });

            if (!recorded.ok) {
              console.error(`[webhook] Release dispatch failed for ${repoFullName}: ${recorded.error}`);
            } else if (!recorded.deduped) {
              const releaseResult: ReleaseResult = {
                status: 'pending_ci',
                message: `Release: dispatched ${workflowFile}@${ref} for ${repoFullName} — awaiting workflow completion`,
                runId: recorded.runId,
                runUrl: recorded.runUrl,
                releaseId: recorded.releaseId,
              };
              try {
                await db
                  .update(tasks)
                  .set({ releaseResult, updatedAt: new Date() })
                  .where(eq(tasks.id, mergedTask.id));
              } catch (err) {
                console.error(`[webhook] could not annotate task ${mergedTask.id} with the release result:`, err);
              }
              console.log(`[webhook] Triggered ${workflowFile}@${ref} for ${repoFullName} (task ${mergedTask.id}, release=${recorded.releaseId}, runId=${recorded.runId ?? 'pending'})`);
            }
          }
        }
      }
    }
  }
}

// Re-fetch a workflow run directly from the GitHub API, returning its current
// conclusion (or undefined if the fetch itself fails — distinct from `null`,
// which means the run genuinely has no conclusion yet). Used to arbitrate a
// second, contradictory `workflow_run.completed` delivery for a run whose
// first delivery already resolved the release row — see the call site.
async function fetchLiveWorkflowRunConclusion(
  installationId: number | undefined,
  repoFullName: string,
  runId: number,
): Promise<string | null | undefined> {
  if (!installationId) return undefined;
  try {
    const data = await githubApi(installationId, `/repos/${repoFullName}/actions/runs/${runId}`);
    return (data?.conclusion ?? null) as string | null;
  } catch (err) {
    console.error(`[webhook:workflow_run] live refetch failed for run ${runId}:`, err);
    return undefined;
  }
}

/**
 * When a workflow_run completes, find the releases row tracking that run and
 * advance its state:
 *   conclusion=success → 'deploying'  (workflow passed; deploy underway), or
 *                        'pending_external' for a gated release
 *   any other terminal conclusion → 'failed'
 *
 * The row is matched by run_url = html_url first. Only when no row carries this
 * url does the head-sha fallback run, and it matches only when ALL hold:
 *   - the row has no run url yet (a row that recorded its run is owned by it);
 *   - the run is a `workflow_dispatch` of the workspace's configured
 *     `releaseConfig.workflowFile`;
 *   - the run's repository is the workspace's linked repo.
 * Every other run on the same sha (CI Auto-Fix, Sync-dev, Build & Test) is a
 * no-op here whatever its conclusion — see isConfiguredReleaseRun.
 *
 * Emits a Pusher event so the UI refreshes in realtime.
 */
async function advanceReleaseStateFromWorkflowRun(
  run: {
    id: number;
    name: string;
    conclusion: string | null;
    html_url: string;
    head_sha: string;
    event?: string;
    path?: string;
    repository: { full_name: string };
  },
  installationId?: number,
): Promise<void> {
  const newState = mapWorkflowConclusionToReleaseState(run.conclusion);
  if (!newState) return;

  // Resolve the row by run URL first, then by the commit the run was for.
  //
  // The URL alone was a single point of failure. `dispatchWorkflowRelease`
  // polls for at most ~15s and, when the run has not surfaced yet, returns no
  // `runUrl` at all — the column stays NULL and no later event can ever match
  // it. It could also record the WRONG url: before the stale-readback fix
  // (3cb9ea16) the readback could return a run from weeks earlier, whose
  // workflow_run event had long since fired. Both cases leave a row stranded
  // in `dispatched` forever, blocking any further non-forced release of that
  // commit. The head sha is the durable identity — for a workflow_dispatch
  // release it is exactly the ref head the row recorded — so fall back to it
  // and backfill the url we should have had.
  //
  // But the sha is shared by every workflow that ran on that commit. Before
  // the fallback was restricted, a CI Auto-Fix run's `skipped` on the release
  // sha stamped a shipped release `failed`, and the real Release success that
  // arrived later was dropped by the terminal-state guard below. So the
  // fallback only ever considers rows with no url, and only accepts the
  // workspace's own configured release workflow (checked after the lookup,
  // since the workflow file lives on the workspace).
  const byUrl = await db
    .select({ id: releases.id, workspaceId: releases.workspaceId, state: releases.state, runUrl: releases.runUrl, archetype: releases.archetype })
    .from(releases)
    .where(eq(releases.runUrl, run.html_url))
    .limit(1);

  let matchingRelease = byUrl[0];
  if (!matchingRelease) {
    // Cheap pre-filter on the hot path: every CI run in every linked repo
    // lands here, and none but a workflow_dispatch can be a release.
    if (run.event !== 'workflow_dispatch') return;

    const [candidate] = await db
      .select({ id: releases.id, workspaceId: releases.workspaceId, state: releases.state, runUrl: releases.runUrl, archetype: releases.archetype })
      .from(releases)
      .where(
        and(
          eq(releases.headSha, run.head_sha),
          isNull(releases.runUrl),
          inArray(releases.state, ['dispatched', 'deploying', 'pending_external']),
        ),
      )
      .orderBy(desc(releases.createdAt))
      .limit(1);
    if (!candidate || candidate.runUrl) return;

    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, candidate.workspaceId),
      columns: { id: true, releaseConfig: true },
      with: { githubRepo: { columns: { fullName: true } } },
    });
    const isRelease = isConfiguredReleaseRun(run, {
      workflowFile: ws?.releaseConfig?.workflowFile,
      repoFullName: (ws as { githubRepo?: { fullName?: string } | null } | undefined)?.githubRepo?.fullName,
    });
    if (!isRelease) {
      console.log(
        `[webhook:workflow_run] run ${run.id} (${run.name}) shares release ${candidate.id}'s sha but is not its ` +
          `configured release workflow — ignoring conclusion=${run.conclusion}`,
      );
      return;
    }
    matchingRelease = candidate;
  }

  // Don't regress from a terminal state.
  if (matchingRelease.state === 'healthy' || matchingRelease.state === 'failed') return;

  // A successful workflow_dispatch run for a `gated` release has only opened
  // the release PR (dev → prodBranch) — nothing has actually deployed yet.
  // Treating it as 'deploying' let `verifyReleaseDeployment` probe the
  // PREVIOUS deploy (still live), stamp the release 'healthy' minutes after
  // dispatch — before the release PR was even reviewed — and get caught out
  // later by the separate deploy-identity check degrading it. The real
  // deploy signal for a gated release is the release PR itself merging into
  // prodBranch (see advanceGatedReleaseOnPrMerge in release-executor.ts,
  // called from the `pull_request` handler below), which is what advances
  // this row to 'deploying' instead.
  //
  // Until then the row moves to 'pending_external', not 'dispatched': the
  // 24h stale-`dispatched` sweep in the release-health-check cron exists for
  // "no workflow_run ever arrived, dispatch outcome unknown" — no longer true
  // once dispatch has succeeded. `pending_external` already means "known
  // in-flight, waiting on something outside buildd's control" everywhere else
  // it's read, which is exactly this.
  const isGatedDispatchSuccess = newState === 'deploying' && matchingRelease.archetype === 'gated';

  // A gated row already in `deploying` got there from its release PR merging
  // (advanceGatedReleaseOnPrMerge) — a gated dispatch success only ever moves
  // a row to `pending_external`. Any dispatch-run conclusion arriving after
  // that — a late or redelivered event, success or not — describes the run
  // that opened the PR, not the release that shipped. A success would move it
  // back to waiting on a merge that already happened; a failure would stamp a
  // shipped release `failed`. Verification owns the row from here.
  if (matchingRelease.archetype === 'gated' && matchingRelease.state === 'deploying') {
    console.log(
      `[webhook:workflow_run] Ignoring conclusion=${run.conclusion} for gated release ${matchingRelease.id} — ` +
        `its release PR already merged`,
    );
    return;
  }

  // GitHub can deliver two `workflow_run.completed` events for the identical
  // run with different reported conclusions — observed for a release job that
  // calls out to a reusable workflow via `uses:`, where the outer run's
  // completed event fires once per inner conclusion before it settles. A run
  // that's actually done doesn't change conclusion, so if this row already
  // advanced from a prior success delivery for this exact run (matched by run
  // URL, not the head-sha fallback) — to 'deploying', or to 'pending_external'
  // for a gated release — a second delivery that disagrees is the same known
  // inconsistency, not new information. Re-fetch the run live and trust that
  // over the webhook payload — mirrors the reconciliation pattern in
  // pr-reconcile.ts for PR state — rather than regressing an already-resolved
  // release to failed on a stale signal.
  if (
    (matchingRelease.state === 'deploying' || matchingRelease.state === 'pending_external') &&
    newState !== 'deploying' &&
    byUrl[0]
  ) {
    const liveConclusion = await fetchLiveWorkflowRunConclusion(installationId, run.repository.full_name, run.id);
    if (liveConclusion !== 'failure') {
      console.log(
        `[webhook:workflow_run] Ignoring conflicting conclusion=${run.conclusion} for release ${matchingRelease.id} — ` +
          `run ${run.id} already resolved success (live check: ${liveConclusion ?? 'unavailable'})`,
      );
      return;
    }
  }

  const resolvedState = isGatedDispatchSuccess ? 'pending_external' : newState;
  const updateFields: Record<string, unknown> = { state: resolvedState };
  if (!matchingRelease.runUrl) updateFields.runUrl = run.html_url;
  if (resolvedState === 'deploying') {
    updateFields.deployedAt = new Date();
  } else if (resolvedState === 'failed') {
    updateFields.failureReason = `workflow conclusion: ${run.conclusion}`;
  }

  await db.update(releases).set(updateFields).where(eq(releases.id, matchingRelease.id));

  console.log(
    `[webhook:workflow_run] Release ${matchingRelease.id} → ${resolvedState} (run ${run.id} on ${run.repository.full_name})`,
  );

  await triggerEvent(channels.workspace(matchingRelease.workspaceId), events.RELEASE_UPDATED, {
    releaseId: matchingRelease.id,
    state: resolvedState,
  });

  if (resolvedState === 'deploying') {
    setTimeout(() => verifyReleaseDeployment(matchingRelease.id, db).catch(console.error), 0);
  }
}

async function readBackWorkflowRun(e: EventOf<'workflow_run.completed'>): Promise<void> {
  const run = e.run;
  const installationId = e.installationId ?? undefined;
  // Find the task whose releaseResult.runId matches this workflow run.
  //
  // This runs for EVERY completed workflow_run — every CI workflow on every
  // push, not just release runs — so the predicate is on a hot path carrying
  // the whole repo's CI volume. Two things make it cheap and safe:
  //
  //   - Compared as TEXT, not `::bigint`. The cast is evaluated per row while
  //     scanning, so one task whose release_result->>'runId' is not numeric
  //     raises 22P02 and every workflow_run delivery 500s — which GitHub then
  //     retries, amplifying the failure. Text equality cannot throw. runId is
  //     always written as a JS number, and JSONB renders an integer back
  //     through ->> as plain digits, so String(run.id) matches exactly.
  //   - `IS NOT NULL` first. It is semantically free (a NULL release_result
  //     could never match) and it is what lets the planner use the partial
  //     index `tasks_release_run_id_idx`, which is indexed
  //     WHERE release_result IS NOT NULL — a few release-dispatching rows
  //     instead of the whole tasks table.
  const matchingTask = await db
    .select({
      id: tasks.id,
      releaseResult: tasks.releaseResult,
      missionId: tasks.missionId,
      workspaceId: tasks.workspaceId,
    })
    .from(tasks)
    .where(
      sql`${tasks.releaseResult} IS NOT NULL AND ${tasks.releaseResult}->>'runId' = ${String(run.id)}`,
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  // Advance the releases row state — runs for ALL workflow_run events regardless
  // of whether a task carries this runId (the two lookups are independent).
  await advanceReleaseStateFromWorkflowRun(run, installationId);

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
    void notifyTeamOf({ taskId: matchingTask.id }, 'needsAttention', {
      title: `Release workflow failed — ${run.name}`,
      message: `Conclusion: ${run.conclusion ?? 'unknown'}. Prod has NOT shipped. Check the run for details.`,
      url: run.html_url,
      urlTitle: 'View workflow run',
      priority: 1,
    });
  }
}

export const releaseSubscribers: readonly AnySubscriber[] = [
  subscriber('releases', 'pr.merged', 'release-record-prod-merge', recordProdMerge),
  subscriber('releases', 'task.pr_merged', 'release-path-b-trigger', releaseOnTaskPrMerge),
  subscriber('releases', 'workflow_run.completed', 'release-workflow-run-readback', readBackWorkflowRun),
];
