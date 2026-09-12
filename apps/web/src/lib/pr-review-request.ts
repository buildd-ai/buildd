/**
 * On-demand PR review — "buildd, review this PR".
 *
 * The webhook path dispatches a reviewer agent only for PRs buildd's own
 * workers opened under an `agent-review` policy. This module is the explicit
 * entry point: any PR in a GitHub-linked workspace can be handed to a reviewer
 * agent by number, including PRs authored outside buildd entirely.
 *
 * An external PR is **adopted** first — a task + worker row mapped to
 * `prNumber` — because every downstream surface (the activity comment, the
 * verdict handler, auto-merge, the merge webhook, `get_pr`) already keys off
 * "the worker that owns this PR". Adoption means none of that needs a second,
 * parallel code path.
 *
 * Waiting is offered three ways, because the right one depends on who is
 * asking: poll {@link readPrReviewStatus} (any client, no infra), bounded
 * long-poll via {@link waitForPrReviewStatus} (one call, capped below the
 * serverless function limit), or an https callback fired once the review
 * reaches a verdict (`firePrReviewCallback`).
 */

import { db } from '@buildd/core/db';
import { tasks, workers, workspaceSkills } from '@buildd/core/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import { fetchSplitPrStats } from './supersession-check';
import {
  derivePrReviewStatus,
  MAX_REVIEW_WAIT_SECONDS,
  REVIEW_POLL_INTERVAL_MS,
  type PrReviewStatus,
  type PrReviewWaitFor,
} from './pr-review-status';

// ── DB reads ──────────────────────────────────────────────────────────────────

/**
 * The newest reviewer task for a PR.
 *
 * Reviewer tasks carry `prNumber` in their JSONB context (not a column), and a
 * request-changes loop creates a fresh one per iteration — newest wins, so the
 * status reflects the review currently in force.
 */
export async function findReviewTaskForPr(
  workspaceId: string,
  prNumber: number,
): Promise<{ id: string; status: string; result: unknown; context: unknown } | null> {
  const rows = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      result: tasks.result,
      context: tasks.context,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.category, 'review'),
        sql`${tasks.context}->>'prNumber' = ${String(prNumber)}`,
      ),
    )
    .orderBy(desc(tasks.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** The worker row that owns this PR in this workspace, if any. */
export async function findPrOwningWorker(workspaceId: string, prNumber: number) {
  return db.query.workers.findFirst({
    where: and(eq(workers.workspaceId, workspaceId), eq(workers.prNumber, prNumber)),
    columns: {
      id: true,
      taskId: true,
      branch: true,
      prUrl: true,
      prLifecycleStatus: true,
      mergedAt: true,
    },
  });
}

export interface AdoptedPrOwnerWorker {
  id: string;
  taskId: string | null;
  branch: string;
  prUrl: string | null;
  prLifecycleStatus: string | null;
  mergedAt: Date | null;
}

export interface AdoptedPrOriginalTask {
  id: string;
  title: string;
  description: string | null;
  backend: 'claude' | 'codex';
  missionId: string | null;
  pathManifest?: string[] | null;
  iteration?: number | null;
  maxIterations?: number | null;
}

/** Minimal shape read off a GitHub `GET /pulls/{number}` response. */
export interface AdoptablePr {
  number: number;
  title?: string | null;
  body?: string | null;
  html_url: string;
  head?: { sha?: string | null; ref?: string | null } | null;
  base?: { sha?: string | null; ref?: string | null } | null;
  additions?: number | null;
  user?: { login?: string | null } | null;
}

/**
 * Resolve the worker that owns a PR, adopting it as a task + worker first when
 * buildd has none.
 *
 * This is THE adoption path (originally inline in the on-demand review route)
 * — every caller that needs "the worker that owns this PR, creating it if
 * buildd did not open the PR" goes through here, so verdicts, the activity
 * comment, merge policy, and (as of the CI-retry webhook) automatic CI-fix
 * dispatch all see the same worker/task shape for an externally-authored PR.
 *
 * The adopted task is stamped `status: 'completed'` and carries
 * `context.adoptedPr` — the work already exists (the PR is open), so a
 * pending row here would be claimable by a runner and get "redone". Callers
 * that gate on task status (e.g. the CI-retry webhook's terminal-task guard)
 * must check for `context.adoptedPr` and treat it as non-terminal for their
 * own purposes; that stamp is what tells them apart from a task whose real
 * agent work actually finished.
 */
export async function resolveOrAdoptPrOwner(params: {
  workspaceId: string;
  installationId: number;
  repoFullName: string;
  prNumber: number;
  pr: AdoptablePr;
  creationSource: 'mcp' | 'webhook' | 'dashboard';
  accountId?: string | null;
}): Promise<{ adopted: boolean; ownerWorker: AdoptedPrOwnerWorker; originalTask: AdoptedPrOriginalTask }> {
  const { workspaceId, installationId, repoFullName, prNumber, pr, creationSource, accountId } = params;

  const existingWorker = await findPrOwningWorker(workspaceId, prNumber);
  if (existingWorker?.taskId) {
    const worker = await db.query.workers.findFirst({
      where: eq(workers.id, existingWorker.id),
      with: { task: true },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const task = (worker as any)?.task;
    return {
      adopted: false,
      ownerWorker: existingWorker,
      originalTask: {
        id: task?.id ?? existingWorker.taskId,
        title: task?.title ?? pr.title ?? `PR #${prNumber}`,
        description: task?.description ?? null,
        backend: task?.backend ?? 'claude',
        missionId: task?.missionId ?? null,
        pathManifest: task?.pathManifest ?? null,
        iteration: typeof task?.context?.iteration === 'number' ? task.context.iteration : 0,
        maxIterations: typeof task?.context?.maxIterations === 'number' ? task.context.maxIterations : 3,
      },
    };
  }

  const [adoptedTask] = await db
    .insert(tasks)
    .values({
      workspaceId,
      title: `PR #${prNumber}: ${pr.title ?? 'untitled'}`,
      description: typeof pr.body === 'string' ? pr.body.slice(0, 8000) : null,
      status: 'completed',
      priority: 5,
      release: 'false',
      creationSource,
      context: {
        adoptedPr: {
          prNumber,
          prUrl: pr.html_url,
          headSha: pr.head?.sha ?? null,
          baseBranch: pr.base?.ref ?? null,
          author: pr.user?.login ?? null,
          adoptedAt: new Date().toISOString(),
        },
      },
    })
    .returning({ id: tasks.id });

  if (!adoptedTask?.id) {
    throw new Error(`Could not adopt PR #${prNumber} on ${repoFullName} (task insert failed)`);
  }

  // Diff stats excluding generated paths (e.g. Drizzle snapshots) — a migration
  // snapshot must not inflate the number shown on task/PR cards.
  const adoptSplit = typeof pr.additions === 'number'
    ? await fetchSplitPrStats(installationId, repoFullName, prNumber)
    : null;

  const [adoptedWorker] = await db
    .insert(workers)
    .values({
      workspaceId,
      taskId: adoptedTask.id,
      accountId: accountId ?? null,
      name: `pr-${prNumber}-adopted`,
      // Not a runner buildd operates — the commits came from elsewhere.
      runner: 'external',
      branch: pr.head?.ref ?? `pr-${prNumber}`,
      status: 'completed',
      prNumber,
      prUrl: pr.html_url,
      prLifecycleStatus: 'pr_open',
      ...(typeof pr.base?.sha === 'string' ? { prOpenedBaseSha: pr.base.sha } : {}),
      ...(typeof pr.base?.ref === 'string' ? { prBaseRef: pr.base.ref } : {}),
      ...(adoptSplit ? { linesAdded: adoptSplit.reviewable.additions } : {}),
      ...(adoptSplit ? { linesRemoved: adoptSplit.reviewable.deletions } : {}),
      ...(adoptSplit ? { filesChanged: adoptSplit.reviewable.files } : {}),
    })
    .returning({ id: workers.id });

  if (!adoptedWorker?.id) {
    throw new Error(`Could not adopt PR #${prNumber} on ${repoFullName} (worker insert failed)`);
  }

  return {
    adopted: true,
    ownerWorker: {
      id: adoptedWorker.id,
      taskId: adoptedTask.id,
      branch: pr.head?.ref ?? `pr-${prNumber}`,
      prUrl: pr.html_url,
      prLifecycleStatus: 'pr_open',
      mergedAt: null,
    },
    originalTask: {
      id: adoptedTask.id,
      title: pr.title ?? `PR #${prNumber}`,
      description: typeof pr.body === 'string' ? pr.body.slice(0, 8000) : null,
      backend: 'claude',
      missionId: null,
      pathManifest: null,
      iteration: 0,
      maxIterations: 3,
    },
  };
}

/** Role slugs registered for a workspace (team-wide rows included). */
export async function listWorkspaceRoles(
  workspaceId: string,
  teamId: string,
): Promise<Array<{ slug: string; isRole: boolean | null }>> {
  const rows = await db
    .select({ slug: workspaceSkills.slug, isRole: workspaceSkills.isRole })
    .from(workspaceSkills)
    .where(
      and(
        eq(workspaceSkills.teamId, teamId),
        eq(workspaceSkills.isRole, true),
        sql`(${workspaceSkills.workspaceId} IS NULL OR ${workspaceSkills.workspaceId} = ${workspaceId})`,
      ),
    );
  return rows;
}

/** Read the current review status for a PR straight from the DB. */
export async function readPrReviewStatus(params: {
  workspaceId: string;
  prNumber: number;
  autoMergeExpected?: boolean;
  waitFor?: PrReviewWaitFor;
}): Promise<PrReviewStatus> {
  const [reviewTask, worker] = await Promise.all([
    findReviewTaskForPr(params.workspaceId, params.prNumber),
    findPrOwningWorker(params.workspaceId, params.prNumber),
  ]);
  return derivePrReviewStatus({
    reviewTask,
    worker: worker ?? null,
    autoMergeExpected: params.autoMergeExpected,
    waitFor: params.waitFor,
  });
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Read the status, and keep reading until it turns terminal or the wait runs out.
 *
 * `waitSeconds: 0` is a plain single read — the same call shape serves both the
 * poll and long-poll styles. A wait longer than {@link MAX_REVIEW_WAIT_SECONDS}
 * is clamped rather than rejected: the caller gets `timedOut: true` and can
 * simply call again, which is strictly better than the function being killed
 * mid-response by the platform timeout.
 */
export async function waitForPrReviewStatus(params: {
  workspaceId: string;
  prNumber: number;
  autoMergeExpected?: boolean;
  waitFor?: PrReviewWaitFor;
  waitSeconds?: number;
  deps?: {
    read?: (p: { workspaceId: string; prNumber: number; autoMergeExpected?: boolean; waitFor?: PrReviewWaitFor }) => Promise<PrReviewStatus>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  };
}): Promise<{ status: PrReviewStatus; timedOut: boolean }> {
  const read = params.deps?.read ?? readPrReviewStatus;
  const sleep = params.deps?.sleep ?? realSleep;
  const now = params.deps?.now ?? Date.now;

  const budgetMs = Math.min(Math.max(params.waitSeconds ?? 0, 0), MAX_REVIEW_WAIT_SECONDS) * 1000;
  const startedAt = now();
  const readArgs = {
    workspaceId: params.workspaceId,
    prNumber: params.prNumber,
    autoMergeExpected: params.autoMergeExpected,
    waitFor: params.waitFor,
  };

  for (;;) {
    const status = await read(readArgs);
    if (status.terminal) return { status, timedOut: false };

    const elapsed = now() - startedAt;
    const remaining = budgetMs - elapsed;
    if (remaining < REVIEW_POLL_INTERVAL_MS) return { status, timedOut: true };
    await sleep(REVIEW_POLL_INTERVAL_MS);
  }
}

/**
 * Claim the single callback delivery for a review.
 *
 * Atomic `UPDATE … WHERE marker IS NULL … RETURNING` — the neon-http driver has
 * no interactive transactions, so this is how the repo does optimistic locking.
 * Whoever gets the row delivers; everyone else sees `already`. That matters
 * because both the verdict handler and the PR-close webhook can reach a review
 * whose terminal point has arrived, and a caller must not get the same verdict
 * pushed twice.
 */
async function claimReviewCallback(reviewTaskId: string): Promise<boolean> {
  const claimed = await db
    .update(tasks)
    .set({
      context: sql`jsonb_set(COALESCE(${tasks.context}, '{}'::jsonb), '{reviewCallbackFiredAt}', to_jsonb(now()::text))`,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, reviewTaskId), sql`${tasks.context}->>'reviewCallbackFiredAt' IS NULL`))
    .returning({ id: tasks.id });
  return claimed.length > 0;
}

export type PrReviewCallbackOutcome = 'fired' | 'skipped' | 'already' | 'failed';

/**
 * Push a review's outcome to the callback URL the requester supplied, once.
 *
 * Best-effort by construction: every failure mode — no callback, not terminal
 * yet, lost claim, dead endpoint — returns a value instead of throwing, because
 * the callers are the verdict handler and the close webhook, and neither may
 * fail over a notification.
 */
export async function deliverPrReviewCallback(params: {
  workspaceId: string;
  prNumber: number;
  repoFullName?: string;
  autoMergeExpected?: boolean;
}): Promise<PrReviewCallbackOutcome> {
  try {
    const reviewTask = await findReviewTaskForPr(params.workspaceId, params.prNumber);
    const callback = asCallback(reviewTask?.context);
    if (!reviewTask || !callback) return 'skipped';

    const worker = await findPrOwningWorker(params.workspaceId, params.prNumber);
    const status = derivePrReviewStatus({
      reviewTask,
      worker: worker ?? null,
      autoMergeExpected: params.autoMergeExpected,
      waitFor: callback.on,
    });
    if (!status.terminal) return 'skipped';

    if (!(await claimReviewCallback(reviewTask.id))) return 'already';

    const { firePrReviewCallback } = await import('./pr-review-status');
    const delivered = await firePrReviewCallback(callback.url, {
      ...status,
      prNumber: params.prNumber,
      ...(params.repoFullName ? { repoFullName: params.repoFullName } : {}),
    });
    return delivered ? 'fired' : 'failed';
  } catch (error) {
    console.warn(
      `[pr-review] callback delivery for PR #${params.prNumber} could not run:`,
      error instanceof Error ? error.message : error,
    );
    return 'skipped';
  }
}

/** Read a stored `reviewCallback` off a reviewer task context, if it is usable. */
function asCallback(context: unknown): { url: string; on: PrReviewWaitFor } | null {
  const raw = context && typeof context === 'object'
    ? (context as Record<string, unknown>).reviewCallback
    : null;
  if (!raw || typeof raw !== 'object') return null;
  const { url, on } = raw as { url?: unknown; on?: unknown };
  if (typeof url !== 'string' || !url.startsWith('https://')) return null;
  return { url, on: on === 'merge' ? 'merge' : 'verdict' };
}
