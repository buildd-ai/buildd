/**
 * Landing and post-merge effect handlers of the workflow kernel
 * (docs/specs/workflow-state-kernel.md §10.2, T15–T17, §14 Slice C), owned by
 * the reviews/merge module and reached only through the composition root
 * (`workflowEffectHandlers()` in apps/web/src/modules.ts).
 *
 *  - `merge_call`: the one `PUT /pulls/{n}/merge` of a kernel-owned PR, pinned
 *    to the head T15 approved; its answer is T16, never a merged fact.
 *  - `verify_merge`: the live read that turns a merge answer into a fact
 *    (`PrMerged` through `ingestFact`), or tells the kernel nothing landed.
 *  - A merge answered `behind` or `conflict` is a conflict-family repair
 *    (T16 → §6.7): its `refresh_branch` and `dispatch_conflict_fix` are the
 *    conflict family's handlers (conflict-retry-effects.ts), not this file's.
 *  - `emit_pr_merged`, `finalize_mission_pr`: the post-merge work, once per
 *    merge, durable in the outbox instead of inline in a request.
 *
 * Every handler re-reads the delivery and is idempotent: the outbox delivers
 * at least once.
 */
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { mergePullRequest, type MergePullRequestResult } from '@/lib/github';
import { classifyMergeFailure } from '@/lib/conflict-retry';
import { finalizeMissionPrMerge } from '@/lib/mission-pr';
import { loadMergedPrOwner, runMergedPrWork } from '@/lib/pr-merged-work';
import type { Command } from './commands';
import type { EffectHandler, EffectHandlers } from './effects';
import { applyCommand, loadView, type Exec } from './kernel';
import { ingestFact } from './facts';
import { githubReader, workspaceRepo } from './github-facts';
import { prUrlOf } from './pr-fact-effects';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

type MergeOutcome = Extract<Command, { type: 'MergeCallResult' }>['outcome'];

/**
 * GitHub's answer to a pinned merge call, as the T16 outcome it is. Only a
 * definite answer is a refusal; anything GitHub did not clearly say is
 * `indeterminate` and verified by a live read before anything acts on it.
 */
export function classifyMergeCall(res: Pick<MergePullRequestResult, 'merged' | 'message' | 'indeterminate'>): MergeOutcome {
  if (res.merged) return 'merged';
  if (res.indeterminate) return 'indeterminate';
  const m = res.message ?? '';
  // The head moved under the pinned call: nothing landed; the new head has its own fact.
  if (/head branch was modified/i.test(m)) return 'not_merged';
  // Branch protection wants an up-to-date branch, or the base moved during the call: refresh.
  if (/base branch was modified|(is|was) (out of date|not up to date)/i.test(m)) return 'behind';
  if (classifyMergeFailure(m) === 'conflict') return 'conflict';
  // "not mergeable" is also what GitHub says to a PR that merged a moment ago: read before deciding.
  if (/not mergeable/i.test(m)) return 'indeterminate';
  return 'refused';
}

// ── merge_call ──────────────────────────────────────────────────────────────

const mergeCall: EffectHandler = async (e) => {
  const d = (await loadView({ deliveryId: e.deliveryId }, dbExec)).delivery;
  const headSha = String(e.payload.headSha ?? '');
  if (!d?.repoFullName || d.prNumber == null) return { outcome: 'skipped:no_pr' };
  if (d.state !== 'LANDING' || d.currentHeadSha !== headSha) return { outcome: `skipped:state_${d.state}` };
  const repo = await workspaceRepo(d.workspaceId);
  if (!repo) throw new Error('no GitHub installation for the workspace');
  const method = (e.payload.mergeMethod as 'merge' | 'squash' | 'rebase' | undefined) ?? 'squash';
  // Pinned to the head T15 approved: a replay at the same head is a no-op or a clean refusal.
  const res = await mergePullRequest(repo.installationId, d.repoFullName, d.prNumber, method, headSha);
  const outcome = classifyMergeCall(res);
  const landingVersion = typeof e.payload.landingVersion === 'number' ? e.payload.landingVersion : undefined;
  const r = await applyCommand(
    { type: 'MergeCallResult', actor: 'effect:merge_call', headSha, outcome, detail: res.message, ...(landingVersion !== undefined ? { landingVersion } : {}) },
    { ref: { deliveryId: d.id }, exec: dbExec },
  );
  return { outcome: `ok:${outcome}:${r.result}` };
};

// ── verify_merge ────────────────────────────────────────────────────────────

const verifyMerge: EffectHandler = async (e) => {
  const d = (await loadView({ deliveryId: e.deliveryId }, dbExec)).delivery;
  if (!d?.repoFullName || d.prNumber == null) return { outcome: 'skipped:no_pr' };
  if (d.state === 'MERGED') return { outcome: 'ok:already_merged' };
  const repo = await workspaceRepo(d.workspaceId);
  if (!repo) throw new Error('no GitHub installation for the workspace');
  const reader = githubReader(repo.installationId);
  const live = await reader.readPr(d.repoFullName, d.prNumber);
  if (!live) throw new Error('live PR read failed');
  const github = { ...reader, readPr: async () => live };
  if (live.merged || live.state === 'closed') {
    // The merged (or closed) fact, from the kernel's own read: T17 / T18.
    const r = await ingestFact({ kind: 'pr_closed', workspaceId: d.workspaceId, source: 'effect:verify_merge', repoFullName: d.repoFullName, prNumber: d.prNumber }, { exec: dbExec, github });
    return { outcome: `ok:${live.merged ? 'merged' : 'closed'}:${r.result}` };
  }
  const headSha = String(e.payload.headSha ?? '');
  if (live.headSha !== headSha) {
    await ingestFact({ kind: 'head_observed', workspaceId: d.workspaceId, source: 'effect:verify_merge', repoFullName: d.repoFullName, prNumber: d.prNumber }, { exec: dbExec, github });
    return { outcome: 'ok:head_moved' };
  }
  if (e.payload.outcome === 'merged') {
    // GitHub accepted the merge and its read has not caught up: read again later (or the webhook arrives first).
    throw new Error('the merge was accepted but the live read still shows the PR open');
  }
  if (d.state !== 'LANDING') return { outcome: `skipped:state_${d.state}` };
  const landingVersion = typeof e.payload.landingVersion === 'number' ? e.payload.landingVersion : undefined;
  const r = await applyCommand(
    { type: 'MergeCallResult', actor: 'effect:verify_merge', headSha, outcome: 'not_merged', detail: 'GitHub shows the PR still open and unmerged after the merge call', ...(landingVersion !== undefined ? { landingVersion } : {}) },
    { ref: { deliveryId: d.id }, exec: dbExec },
  );
  return { outcome: `ok:not_merged:${r.result}` };
};

// ── post-merge work (T17) ───────────────────────────────────────────────────

const emitPrMerged: EffectHandler = async (e) => {
  const d = (await loadView({ deliveryId: e.deliveryId }, dbExec)).delivery;
  if (!d?.repoFullName || d.prNumber == null) return { outcome: 'skipped:no_pr' };
  if (d.state !== 'MERGED') return { outcome: `skipped:state_${d.state}` };
  const owner = await loadMergedPrOwner(d.repoFullName, d.prNumber);
  if (!owner) return { outcome: 'skipped:no_worker' };
  const repo = await workspaceRepo(d.workspaceId);
  const task = owner.task;
  await runMergedPrWork({
    worker: { id: owner.id, workspaceId: owner.workspaceId, taskId: owner.taskId ?? null },
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
  return { outcome: 'ok' };
};

const finalizeMissionPr: EffectHandler = async (e) => {
  const d = (await loadView({ deliveryId: e.deliveryId }, dbExec)).delivery;
  if (!d?.repoFullName || d.state !== 'MERGED') return { outcome: `skipped:state_${d?.state ?? 'none'}` };
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, d.ownerTaskId), columns: { title: true, taskClass: true, missionId: true } });
  const repo = await workspaceRepo(d.workspaceId);
  if (!repo) throw new Error('no GitHub installation for the workspace');
  // Deletes the mission branch after the mission PR ships, whichever door (or a person on GitHub) merged it.
  await finalizeMissionPrMerge(task ?? null, repo.installationId, d.repoFullName);
  return { outcome: 'ok' };
};

/** The landing family, added at the composition root. */
export function withLandingEffects(base: EffectHandlers): EffectHandlers {
  return {
    ...base,
    merge_call: mergeCall,
    verify_merge: verifyMerge,
    emit_pr_merged: emitPrMerged,
    finalize_mission_pr: finalizeMissionPr,
  };
}

// Exported for tests.
export const __handlers = { mergeCall, verifyMerge, emitPrMerged, finalizeMissionPr };
