/**
 * buildd's half of the landing and post-merge effects
 * (docs/specs/workflow-state-kernel.md §10.2, T15–T17, §14 Slice C), owned by
 * the reviews/merge module. The handlers (`merge_call`, `verify_merge`,
 * `emit_pr_merged`, `finalize_mission_pr`) are the package's
 * (packages/workflow-kernel/src/handlers/landing.ts), composed at the root
 * (`workflowKernel()` in apps/web/src/modules.ts); this file supplies what
 * they reach through the ports:
 *
 *  - `mergeAnswerOf`: how GitHub's answer to the pinned merge call reads as
 *    the T16 outcome (`GithubWrites.mergeAtHead`, kernel-ports.ts).
 *  - `landingLifecycle`: the post-merge work, once per merge
 *    (`Lifecycle.merged`) and the mission branch's deletion after a mission
 *    PR ships (`Lifecycle.finalizeMerge`).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import type { MergePullRequestResult } from '@/lib/github';
import { classifyMergeFailure } from '@/lib/conflict-retry';
import { finalizeMissionPrMerge } from '@/lib/mission-pr';
import { runMergedPrWork } from '@/lib/pr-merged-work';
import { workerOwnsPr } from '@/lib/repo-scope';
import type { Lifecycle, MergeAnswer as PortMergeAnswer, MergeCallOutcome } from '@buildd/workflow-kernel/ports';
import { workspaceRepo } from './github-facts';
import { prUrlOf } from './pr-fact-effects';
import { sqlOrderByFn, sqlWhere } from '@buildd/core/db/relational-sql';

type MergeOutcome = MergeCallOutcome;

type MergeAnswer = Pick<MergePullRequestResult, 'merged' | 'message' | 'indeterminate' | 'status' | 'retryAfterMs'>;

/**
 * A rate limit: 429, or a 403 GitHub sent as one (its message, or reset
 * headers). GitHub refuses these before it looks at the PR, so nothing landed.
 * https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 */
function rateLimited(res: MergeAnswer): boolean {
  if (res.status === 429) return true;
  return res.status === 403 && (/rate limit/i.test(res.message ?? '') || res.retryAfterMs != null);
}

/**
 * GitHub's answer to a pinned merge call, as the T16 outcome it is. Classified
 * by status first: a rate limit is `not_merged` (nothing landed, landing may be
 * asked again), and a 5xx is GitHub failing rather than answering, so it is
 * `indeterminate` and verified by a live read. Only a definite answer is a
 * refusal; anything GitHub did not clearly say is `indeterminate` too.
 */
export function classifyMergeCall(res: MergeAnswer): MergeOutcome {
  if (res.merged) return 'merged';
  if (res.indeterminate) return 'indeterminate';
  if (rateLimited(res)) return 'not_merged';
  if (res.status != null && res.status >= 500) return 'indeterminate';
  const m = res.message ?? '';
  // The head moved under the pinned call: nothing landed; the new head has its own fact.
  if (/head branch was modified/i.test(m)) return 'not_merged';
  // A draft waits for ready_for_review (the kernel refuses to land one; this is a draft made between the read and the call).
  if (/\bdraft\b/i.test(m)) return 'not_merged';
  // Branch protection wants an up-to-date branch, or the base moved during the call: refresh.
  if (/base branch was modified|(is|was) (out of date|not up to date)/i.test(m)) return 'behind';
  if (classifyMergeFailure(m) === 'conflict') return 'conflict';
  // "not mergeable" is also what GitHub says to a PR that merged a moment ago: read before deciding.
  if (/not mergeable/i.test(m)) return 'indeterminate';
  return 'refused';
}

/** A rate limit sent without a reset: GitHub's docs say wait at least a minute. */
const RATE_LIMIT_DEFAULT_WAIT_MS = 60_000;
/** Primary limits reset hourly; never park a landing longer than that on one answer. */
const MAX_MERGE_RETRY_WAIT_MS = 3_600_000;

/**
 * When the landing sweep may call again after a transient answer (a rate limit
 * or a 5xx), honouring `retry-after` / `x-ratelimit-reset`; null when GitHub
 * asked for no wait. Recorded on the MergeCallResult; `listApprovedKernelPrs`
 * skips the delivery until then.
 */
export function mergeRetryAt(res: MergeAnswer, now = Date.now()): string | null {
  if (res.merged) return null;
  const limited = rateLimited(res);
  const failing = res.status != null && res.status >= 500;
  if (!limited && !failing) return null;
  const wait = res.retryAfterMs ?? (limited ? RATE_LIMIT_DEFAULT_WAIT_MS : null);
  if (wait == null) return null;
  return new Date(now + Math.min(Math.max(0, wait), MAX_MERGE_RETRY_WAIT_MS)).toISOString();
}

/** GitHub's merge answer as the port's `MergeAnswer`: the T16 outcome, what GitHub said, and when to call again. */
export function mergeAnswerOf(res: MergeAnswer, now = Date.now()): PortMergeAnswer {
  return { outcome: classifyMergeCall(res), detail: res.message, retryAt: mergeRetryAt(res, now) };
}

// ── post-merge work (T17) ───────────────────────────────────────────────────

export const landingLifecycle: Pick<Lifecycle, 'merged' | 'finalizeMerge'> = {
  async merged(d) {
    if (!d.repoFullName || d.prNumber == null) return false;
    // Scoped to the delivery's workspace: another workspace on the same repo can carry a worker row
    // with this PR number and url, and the merge must never complete that workspace's task.
    const owner = await db.query.workers.findFirst({
      where: sqlWhere(and(eq(workers.workspaceId, d.workspaceId), workerOwnsPr(d.repoFullName, d.prNumber))),
      orderBy: sqlOrderByFn((w, { asc }) => [asc(w.createdAt)]),
      with: { task: true },
    });
    if (!owner) return false;
    const repo = await workspaceRepo(d.workspaceId);
    const task = owner.task;
    await runMergedPrWork({
      worker: { id: owner.id, workspaceId: owner.workspaceId, taskId: owner.taskId ?? null, runner: owner.runner },
      task: task
        ? {
            id: task.id, status: task.status, workspaceId: task.workspaceId, missionId: task.missionId ?? null,
            taskClass: task.taskClass ?? null, release: task.release ?? null, loopState: task.loopState ?? null,
          }
        : null,
      repoFullName: d.repoFullName,
      prNumber: d.prNumber,
      prUrl: prUrlOf(d.repoFullName, d.prNumber),
      prHtmlUrl: prUrlOf(d.repoFullName, d.prNumber),
      baseRef: d.baseRef,
      headSha: d.currentHeadSha ?? '',
      installationId: repo?.installationId ?? null,
      mergedAt: d.mergedAt ?? new Date(),
      // One effect per merge (its dedupe key): the once-per-merge steps run here, and the
      // webhook skips them for a kernel-owned PR.
      mergeIsNew: true,
      // stamp_pr_rows owns the fact-cache stamp.
      stamp: false,
    });
    return true;
  },

  async finalizeMerge(d) {
    if (!d.repoFullName) return;
    const task = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, d.ownerTaskId)), columns: { title: true, taskClass: true, missionId: true } });
    const repo = await workspaceRepo(d.workspaceId);
    if (!repo) throw new Error('no GitHub installation for the workspace');
    // Deletes the mission branch after the mission PR ships, whichever door (or a person on GitHub) merged it.
    await finalizeMissionPrMerge(task ?? null, repo.installationId, d.repoFullName);
  },
};
