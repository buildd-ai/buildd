/**
 * DB half of PR comment follow-up (see `pr-comment-followup.ts`): the PR's
 * owner and its workspace's mode, the instruct-queue write, and the gate-ledger
 * record that doubles as the redelivery idempotency key.
 *
 * `runPrCommentFollowup` never throws: the webhook is the contract, a nudge is
 * a nicety.
 */
import { db } from '@buildd/core/db';
import { gateEvents, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { recordGateEvent, GATE_SLUGS } from '@buildd/core/gate-events';
import { TERMINAL_WORKER_STATUSES } from '@buildd/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { workerOwnsPr, workspaceRepoMatches } from '@/lib/repo-scope';
import { queueSystemInstruction } from '@/lib/system-instruction-queue';
import {
  deliverPrComment,
  resolvePrCommentMode,
  type PrCommentDeps,
  type PrCommentEvent,
  type PrCommentMode,
  type PrCommentOwner,
  type PrCommentResult,
} from '@/lib/pr-comment-followup';

export const PR_COMMENT_SURFACE = 'POST /api/github/webhook';

export type PrCommentSource = 'issue_comment' | 'review_comment';

interface Context {
  owner: PrCommentOwner | null;
  workspaceId: string | null;
  mode: PrCommentMode;
}

/**
 * The PR's owner, preferring a live worker over an ended one (a PR can outlive
 * one worker and be picked up by another), and the mode of its workspace. With
 * no owning worker the mode comes from the workspace bound to the repo.
 */
async function loadContext(repoFullName: string, prNumber: number): Promise<Context> {
  const rows = await db
    .select({
      workerId: workers.id,
      taskId: workers.taskId,
      workspaceId: workers.workspaceId,
      status: workers.status,
      missionId: tasks.missionId,
      dataClass: workspaces.dataClass,
      gitConfig: workspaces.gitConfig,
    })
    .from(workers)
    .leftJoin(tasks, eq(tasks.id, workers.taskId))
    .leftJoin(workspaces, eq(workspaces.id, workers.workspaceId))
    .where(workerOwnsPr(repoFullName, prNumber))
    .orderBy(desc(workers.createdAt))
    .limit(10);

  const terminal = TERMINAL_WORKER_STATUSES as readonly string[];
  const row = rows.find(r => !terminal.includes(r.status)) ?? rows[0];
  if (row) {
    return {
      owner: {
        workerId: row.workerId,
        taskId: row.taskId ?? null,
        workspaceId: row.workspaceId,
        missionId: row.missionId ?? null,
        status: row.status,
        sensitive: row.dataClass === 'sensitive',
      },
      workspaceId: row.workspaceId,
      mode: resolvePrCommentMode(row.gitConfig, repoFullName),
    };
  }

  const [ws] = await db
    .select({ id: workspaces.id, gitConfig: workspaces.gitConfig })
    .from(workspaces)
    .where(workspaceRepoMatches(repoFullName))
    .limit(1);
  return { owner: null, workspaceId: ws?.id ?? null, mode: ws ? resolvePrCommentMode(ws.gitConfig, repoFullName) : 'off' };
}

/** True when this comment was already delivered (a redelivered webhook after the runner drained its queue). */
async function alreadyDelivered(repoFullName: string, commentId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: gateEvents.id })
    .from(gateEvents)
    .where(and(
      eq(gateEvents.gate, GATE_SLUGS.PR_COMMENT_FOLLOWUP),
      sql`${gateEvents.detail} @> ${JSON.stringify({ repoFullName, commentId, delivered: true })}::jsonb`,
    ))
    .limit(1);
  return !!row;
}

export function createPrCommentStore(ctx: Context, source: PrCommentSource, sensitive: boolean): PrCommentDeps {
  return {
    botLogins: [],
    resolveOwner: async () => ctx.owner,
    // The marker covers a redelivery while the instruction is still queued; the
    // ledger check in runPrCommentFollowup covers one after the runner drained it.
    queueInstruction: (workerId, text, marker) => queueSystemInstruction(workerId, text, { marker, sensitive }),
    async record(rec) {
      await recordGateEvent({
        gate: GATE_SLUGS.PR_COMMENT_FOLLOWUP,
        surface: PR_COMMENT_SURFACE,
        outcome: rec.delivered ? 'accepted' : 'warned',
        reason: rec.delivered ? 'pr comment delivered to the live owner' : 'pr comment would be delivered (recording)',
        workspaceId: rec.workspaceId,
        missionId: rec.missionId,
        taskId: rec.taskId,
        workerId: rec.workerId,
        callerOrigin: 'system',
        detail: {
          repoFullName: rec.repoFullName, prNumber: rec.prNumber, commentId: rec.commentId,
          mode: rec.mode, delivered: rec.delivered, source,
        },
      });
    },
    async recordSkip(skip) {
      const workspaceId = skip.owner?.workspaceId ?? ctx.workspaceId;
      if (!workspaceId) return;
      await recordGateEvent({
        gate: GATE_SLUGS.PR_COMMENT_FOLLOWUP,
        surface: PR_COMMENT_SURFACE,
        outcome: 'rejected',
        reason: `pr comment not delivered: ${skip.reason}`,
        workspaceId,
        missionId: skip.owner?.missionId ?? null,
        taskId: skip.owner?.taskId ?? null,
        workerId: skip.owner?.workerId ?? null,
        callerOrigin: 'system',
        detail: {
          repoFullName: skip.repoFullName, prNumber: skip.prNumber, commentId: skip.commentId,
          mode: skip.mode, delivered: false, reason: skip.reason, source,
          authorLogin: skip.authorLogin, authorAssociation: skip.authorAssociation,
        },
      });
    },
  };
}

/** Hand one PR comment to its live owner per the workspace's mode. Never throws. */
export async function runPrCommentFollowup(event: PrCommentEvent, source: PrCommentSource): Promise<PrCommentResult> {
  try {
    const ctx = await loadContext(event.repoFullName, event.prNumber);
    if (ctx.mode === 'off') return { outcome: 'skipped', reason: 'flag_off' };
    if (ctx.mode === 'acting' && await alreadyDelivered(event.repoFullName, event.commentId)) {
      return { outcome: 'skipped', reason: 'duplicate' };
    }
    return await deliverPrComment(event, ctx.mode, createPrCommentStore(ctx, source, ctx.owner?.sensitive ?? false));
  } catch (err) {
    console.error(`[pr-comment-followup] ${event.repoFullName}#${event.prNumber} comment ${event.commentId} failed:`, err);
    return { outcome: 'skipped', reason: 'error' };
  }
}
