/**
 * Who a reviewer is, and which PR its verdict may act on, comes from rows the
 * server owns, never from fields a caller wrote.
 *
 * - The keys that make a task a dispatched review (`reviewerFor`, and the
 *   kernel round it answers) are written only by the review system
 *   (`createReviewerTask`). Every path that stores caller-supplied context on a
 *   new task drops them: POST /api/tasks (which MCP create_task and chat use)
 *   and the schedule/mission task templates.
 * - A verdict acts only for a review whose reviewed task is in the reviewer's
 *   own workspace and is its parent, and only through the repo and
 *   installation linked to that workspace.
 */
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { isDispatchedReview } from '@/lib/read-only-review';
import { workspaceRepo } from '@/lib/workflow/github-facts';

/** Context keys only the review system writes. */
export const REVIEW_DISPATCH_CONTEXT_KEYS = ['reviewerFor', 'workflowRoundId'] as const;

/** `context` without the keys only the review system writes; anything else passes through unchanged. */
export function withoutReviewDispatchContext<T>(context: T): T {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return context;
  const ctx = context as Record<string, unknown>;
  if (!REVIEW_DISPATCH_CONTEXT_KEYS.some((k) => k in ctx)) return context;
  const rest: Record<string, unknown> = { ...ctx };
  for (const k of REVIEW_DISPATCH_CONTEXT_KEYS) delete rest[k];
  return rest as T;
}

export type DispatchedReview =
  | { ok: true; originalTaskId: string; prNumber: number; repoFullName: string; installationId: number }
  | { ok: false; reason: string };

/**
 * The PR a finished review task may act on, resolved from server state, or why
 * it may act on none. `workspaceId` is the reviewer worker's workspace.
 */
export async function resolveDispatchedReview(
  task: { id: string; workspaceId: string | null; category: string | null; context: unknown; parentTaskId: string | null },
  workspaceId: string,
  deps: { repoOf?: typeof workspaceRepo } = {},
): Promise<DispatchedReview> {
  if (!isDispatchedReview(task.category, task.context)) return { ok: false, reason: 'not a dispatched review' };
  const ctx = (task.context ?? {}) as Record<string, unknown>;
  const originalTaskId = ctx.reviewerFor as string;
  if (task.workspaceId !== workspaceId) return { ok: false, reason: 'review task is not in the worker\'s workspace' };
  if (task.parentTaskId !== originalTaskId) return { ok: false, reason: 'review task is not a child of the task it reviews' };
  const prNumber = ctx.prNumber;
  if (typeof prNumber !== 'number' || !Number.isInteger(prNumber) || prNumber <= 0) return { ok: false, reason: 'no PR number' };

  const original = await db.query.tasks.findFirst({ where: eq(tasks.id, originalTaskId), columns: { id: true, workspaceId: true } });
  if (!original || original.workspaceId !== workspaceId) return { ok: false, reason: 'reviewed task is not in this workspace' };

  const repo = await (deps.repoOf ?? workspaceRepo)(workspaceId);
  if (!repo) return { ok: false, reason: 'workspace has no linked repo' };
  const named = typeof ctx.repoFullName === 'string' ? ctx.repoFullName : null;
  if (named && named.toLowerCase() !== repo.repoFullName.toLowerCase()) {
    return { ok: false, reason: `review names ${named}, not this workspace's repo` };
  }
  return { ok: true, originalTaskId, prNumber, repoFullName: repo.repoFullName, installationId: repo.installationId };
}
