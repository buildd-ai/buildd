/**
 * Release tasks held on a PR (workflow-kernel-library.md §4): a release that could not land
 * when its task finished (CI pending, the kernel not landed yet, the control plane down) is
 * recorded on the task (`context.releasePrPending`, `releasePrNumber`, `releaseMergeMethod`)
 * and settled later by the PR:
 *  - CI goes green: `handleReleasePrCiSuccess` merges it (the release-on-green door, D7);
 *  - the PR merges (any door, or a person): the task completes;
 *  - the PR closes unmerged: the task fails with the reason;
 *  - nothing arrives (CI was already green, the control plane was down, the PR landed by
 *    another path): the hourly `sweepHeldReleases` reads the PR and does whichever of the
 *    above applies, retrying a merge a bounded number of times before failing the task.
 * Core: the GitHub webhook and the pr-reconcile cron both reach it.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { allCheckSuitesPassed, githubApi, mergePullRequest } from '@/lib/github';
import { notifyTeamOf } from '@/lib/notify';
import { emitHeldReleaseOutcome } from '@/lib/task-outcome-event';
import { guardReviewVerdict } from '@/lib/review-verdict-gate';
import { fireGateEvent, GATE_SLUGS } from '@/lib/gate-ledger';
import { workspaceRepo } from '@/lib/workflow/github-facts';

/**
 * D7's kernel landing through the one client. `null`: the kernel does not own the release
 * PR (read locally, so such a PR never reaches the kernel and merges pinned below as before).
 * `'unavailable'`: the control plane did not answer; the release stays pending, never thrown,
 * because GitHub does not redeliver this event.
 */
async function releaseKernelLand(p: Parameters<typeof import('@/lib/workflow/kernel-client').landThroughKernel>[0]) {
  const { kernelDeliveryForPr } = await import('@/lib/workflow/authority');
  if (!(await kernelDeliveryForPr(p.workspaceId, p.repoFullName, p.prNumber))) return null;
  const client = await import('@/lib/workflow/kernel-client');
  try {
    // buildd's own door on a webhook: the system principal, named by its actor.
    return await client.landThroughKernel(p, { principal: client.systemPrincipal('system:release_pr_ci_success') });
  } catch (err) {
    if (!client.isDoorError(err)) throw err;
    console.warn(`[release-pr] the control plane did not land ${p.repoFullName}#${p.prNumber}; the release stays pending:`, err.message);
    return 'unavailable' as const;
  }
}

/**
 * When CI goes green on a PR that a release task is tracking, merge the release
 * PR and mark the task completed. This is the event-driven completion path for
 * the pending_ci release state — the counterpart to executeRelease returning
 * pending_ci when CI is still running at the time the worker finishes.
 */
export async function handleReleasePrCiSuccess(
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

  // D7 (workflow-kernel-library.md §4): a release PR the kernel owns lands through the
  // kernel, pinned to this head; its merge effect asks the landing gate again when it runs.
  // The method the hold recorded: a held worker PR (every_merge) squashes; a release PR merges.
  const heldMethod = (pendingReleaseTasks[0]!.context as Record<string, unknown> | null)?.releaseMergeMethod === 'squash' ? 'squash' as const : 'merge' as const;
  const kernelAnswer = await releaseKernelLand({
    workspaceId: pendingReleaseTasks[0]!.workspaceId, installationId, repoFullName, prNumber, headSha,
    door: 'release_pr_ci_success', actor: 'system:release_pr_ci_success', mergeMethod: heldMethod,
  });
  // Nothing applied and nothing recorded: the release task stays pending for the next green CI or sweep.
  if (kernelAnswer === 'unavailable') return;
  const kernelLanding = kernelAnswer;
  if (kernelLanding && !kernelLanding.merged) {
    // The kernel owns it and did not land it (not approved at this head yet, a repair, the gate
    // at merge time): the release waits for the kernel, it has not failed.
    console.log(`[release-pr] ${repoFullName}#${prNumber} not landed by the kernel yet (${kernelLanding.reason}); the release stays pending`);
    return;
  }

  // Release promotion is a merge door like any other. buildd never dispatches a
  // reviewer for a release PR on its own, so the gate normally reads
  // `not_requested` and passes — but `request_pr_review` can be pointed at any
  // PR, and a release that ships past its own reviewer's finding is the one
  // merge where that matters most.
  const releaseGate = kernelLanding ? { blocks: false as const } : await guardReviewVerdict({
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

  const mergeResult = kernelLanding
    ? { merged: kernelLanding.merged, message: kernelLanding.message }
    : await mergePullRequest(installationId, repoFullName, prNumber, heldMethod, headSha);

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


/** How many hourly sweeps a held release is retried before it fails with the reason. */
export const MAX_HELD_RELEASE_SWEEPS = 24;

export interface HeldReleaseTask { id: string; workspaceId: string; context: unknown }

const ctxOf = (t: HeldReleaseTask): Record<string, unknown> => (t.context && typeof t.context === 'object' ? (t.context as Record<string, unknown>) : {});

/** Settle one held release task, once: only while it is still held (a redelivery settles nothing twice). */
export async function settleHeldReleaseTask(
  task: HeldReleaseTask,
  o: { merged: true; prNumber: number; repoFullName: string; via: string } | { merged: false; prNumber: number; repoFullName: string; reason: string; title: string },
): Promise<boolean> {
  const ctx = ctxOf(task);
  const prUrl = ctx.releasePrUrl as string | undefined;
  const releaseResult = o.merged
    ? { status: 'completed' as const, message: `Release: completed — PR #${o.prNumber} merged to ${o.repoFullName} (${o.via})`, mergedAt: new Date().toISOString(), releasePrNumber: o.prNumber, releasePrUrl: prUrl } // pr-fact-guard: not a workers write (release task result)
    : { status: 'failed' as const, message: `Release: FAILED — ${o.reason}`, error: o.reason, releasePrNumber: o.prNumber, releasePrUrl: prUrl };
  const rows = await db.update(tasks)
    .set({ status: o.merged ? 'completed' : 'failed', releaseResult, context: { ...ctx, releasePrPending: false }, updatedAt: new Date() })
    .where(and(eq(tasks.id, task.id), sql`(${tasks.context}->>'releasePrPending')::boolean = true`))
    .returning({ id: tasks.id });
  if (!rows.length) return false;
  if (o.merged) {
    console.log(`[release-pr] Task ${task.id} completed: PR #${o.prNumber} merged on ${o.repoFullName} (${o.via})`);
    await emitHeldReleaseOutcome(task.id, null);
  } else {
    void notifyTeamOf({ taskId: task.id }, 'needsAttention', {
      title: `${o.title} — ${o.repoFullName}#${o.prNumber}`, message: o.reason, priority: 1,
      url: prUrl || `https://github.com/${o.repoFullName}/pull/${o.prNumber}`, urlTitle: 'Open PR',
    });
    console.error(`[release-pr] Task ${task.id} FAILED: ${o.reason}`);
    await emitHeldReleaseOutcome(task.id, { slot: 'release', label: 'Release failed', reason: o.reason });
  }
  return true;
}

/** The tasks held on PR `prNumber` of `repoFullName` (the task's own workspace's repo). */
export async function heldReleaseTasksForPr(repoFullName: string, prNumber: number, repoFor: typeof workspaceRepo = workspaceRepo): Promise<HeldReleaseTask[]> {
  const rows = await db.select({ id: tasks.id, workspaceId: tasks.workspaceId, context: tasks.context }).from(tasks)
    .where(and(sql`(${tasks.context}->>'releasePrPending')::boolean = true`, sql`(${tasks.context}->>'releasePrNumber')::int = ${prNumber}`))
    .limit(5);
  const out: HeldReleaseTask[] = [];
  for (const r of rows) if ((await repoFor(r.workspaceId))?.repoFullName === repoFullName) out.push(r);
  return out;
}

/** A PR closed: every release task held on it is settled by how it closed. */
export async function settleHeldReleasesOnClose(p: { repoFullName: string; prNumber: number; merged: boolean }, repoFor: typeof workspaceRepo = workspaceRepo): Promise<number> {
  let n = 0;
  for (const t of await heldReleaseTasksForPr(p.repoFullName, p.prNumber, repoFor)) {
    const done = p.merged
      ? await settleHeldReleaseTask(t, { merged: true, prNumber: p.prNumber, repoFullName: p.repoFullName, via: 'the PR merged' })
      : await settleHeldReleaseTask(t, { merged: false, prNumber: p.prNumber, repoFullName: p.repoFullName, reason: `PR #${p.prNumber} closed without merging; nothing was released`, title: 'Release PR closed' });
    if (done) n++;
  }
  return n;
}

export interface HeldReleaseSweepDeps {
  repoFor?: typeof workspaceRepo;
  api?: (installationId: number, path: string) => Promise<any>;
  ciGreen?: (installationId: number, repoFullName: string, headSha: string) => Promise<boolean>;
  retry?: typeof handleReleasePrCiSuccess;
}

export interface HeldReleaseSweep { scanned: number; completed: number; failed: number; retried: number; waiting: number; errors: number }

/**
 * The backstop for held releases (rides pr-reconcile's hourly tick, no wake window of its own):
 * each held task's PR is read live; a merged PR completes the task, a closed one fails it, an
 * open green one is retried through the release-on-green door, and a task held past
 * `MAX_HELD_RELEASE_SWEEPS` sweeps fails with the reason, so no release stays pending forever.
 */
export async function sweepHeldReleases(opts: { limit?: number; maxSweeps?: number; workspaceId?: string } = {}, deps: HeldReleaseSweepDeps = {}): Promise<HeldReleaseSweep> {
  const repoFor = deps.repoFor ?? workspaceRepo;
  const api = deps.api ?? githubApi;
  const ciGreen = deps.ciGreen ?? allCheckSuitesPassed;
  const retry = deps.retry ?? handleReleasePrCiSuccess;
  const max = opts.maxSweeps ?? MAX_HELD_RELEASE_SWEEPS;
  const out: HeldReleaseSweep = { scanned: 0, completed: 0, failed: 0, retried: 0, waiting: 0, errors: 0 };
  const rows = await db.select({ id: tasks.id, workspaceId: tasks.workspaceId, context: tasks.context }).from(tasks)
    .where(and(sql`(${tasks.context}->>'releasePrPending')::boolean = true`, ...(opts.workspaceId ? [eq(tasks.workspaceId, opts.workspaceId)] : [])))
    .orderBy(tasks.updatedAt)
    .limit(opts.limit ?? 20);
  for (const t of rows) {
    out.scanned++;
    try {
      const ctx = ctxOf(t);
      const prNumber = Number(ctx.releasePrNumber);
      const repo = await repoFor(t.workspaceId);
      if (!repo || !Number.isFinite(prNumber)) { out.errors++; continue; }
      const pr = await api(repo.installationId, `/repos/${repo.repoFullName}/pulls/${prNumber}`).catch(() => null);
      if (pr?.merged === true) {
        if (await settleHeldReleaseTask(t, { merged: true, prNumber, repoFullName: repo.repoFullName, via: 'found merged by the hourly sweep' })) out.completed++;
        continue;
      }
      if (pr?.state === 'closed') {
        if (await settleHeldReleaseTask(t, { merged: false, prNumber, repoFullName: repo.repoFullName, reason: `PR #${prNumber} closed without merging; nothing was released`, title: 'Release PR closed' })) out.failed++;
        continue;
      }
      const sweeps = (typeof ctx.releaseHoldSweeps === 'number' ? ctx.releaseHoldSweeps : 0) + 1;
      if (sweeps > max) {
        if (await settleHeldReleaseTask(t, { merged: false, prNumber, repoFullName: repo.repoFullName, reason: `PR #${prNumber} was still not merged after ${max} hourly retries; nothing was released. Land it, or release again.`, title: 'Release held too long' })) out.failed++;
        continue;
      }
      await db.update(tasks).set({ context: { ...ctx, releaseHoldSweeps: sweeps } })
        .where(and(eq(tasks.id, t.id), sql`(${tasks.context}->>'releasePrPending')::boolean = true`));
      const head = pr?.head?.sha as string | undefined;
      if (head && await ciGreen(repo.installationId, repo.repoFullName, head).catch(() => false)) {
        // CI is green and no event is coming: the release-on-green door, as if it had just gone green.
        await retry(prNumber, repo.installationId, repo.repoFullName, head);
        out.retried++;
      } else out.waiting++;
    } catch (err) {
      out.errors++;
      console.error(`[held-release] sweep of task ${t.id} failed:`, err);
    }
  }
  return out;
}
