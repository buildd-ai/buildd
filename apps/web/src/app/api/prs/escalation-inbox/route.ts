/**
 * GET /api/prs/escalation-inbox
 *
 * Returns PRs requiring human action for the escalation inbox (BT-15).
 * Includes:
 * - PRs where the reviewer escalated (reviewer_escalated mission_note exists)
 * - PRs where the agent approved under approve-only gate (reviewer_approved note)
 * - PRs where workspace merge policy tier = 'human'
 *
 * Excludes:
 * - PRs currently held under an active agent-review lease (agent_reviewing)
 *
 * Auth: session user.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, tasks, workspaces, missionNotes } from '@buildd/core/db/schema';
import { eq, and, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import { resolvePolicy } from '@/lib/merge-policy';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const wsIds = await getUserWorkspaceIds(user.id);
  if (wsIds.length === 0) {
    return NextResponse.json({ items: [], count: 0 });
  }

  // Find workers with open (unmerged, non-closed) PRs in user's workspaces
  const openPrWorkers = await db.query.workers.findMany({
    where: and(
      inArray(workers.workspaceId, wsIds),
      isNotNull(workers.prUrl),
      isNull(workers.mergedAt),
      sql`COALESCE(${workers.prLifecycleStatus}, 'pr_open') NOT IN ('closed', 'merged')`,
    ),
    columns: {
      id: true,
      taskId: true,
      workspaceId: true,
      prUrl: true,
      prNumber: true,
      prLifecycleStatus: true,
      completedAt: true,
    },
    with: {
      task: {
        columns: { id: true, title: true, missionId: true },
      },
    },
  });

  if (openPrWorkers.length === 0) {
    return NextResponse.json({ items: [], count: 0 });
  }

  const openTaskIds = openPrWorkers.map(w => w.taskId).filter(Boolean) as string[];

  // ── Lease detection ────────────────────────────────────────────────────────
  // Find reviewer tasks (category='review') in these workspaces that have a
  // live worker. Each reviewer task's context.reviewerFor points to the original
  // task ID — this is the lease: while such a worker is live, the PR is held.
  const reviewerLiveMap = new Map<string, { reviewerWorkerId: string; reviewerRoleSlug: string | null }>();
  if (openTaskIds.length > 0) {
    const reviewerTasksWithWorkers = await db.query.tasks.findMany({
      where: and(
        inArray(tasks.workspaceId, wsIds),
        eq(tasks.category, 'review'),
        inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
      ),
      columns: { id: true, context: true, roleSlug: true },
      with: {
        workers: {
          where: inArray(workers.status, [...LIVE_WORKER_STATUSES]),
          columns: { id: true, status: true },
          limit: 1,
        },
      },
    });

    const openTaskIdSet = new Set(openTaskIds);
    for (const rt of reviewerTasksWithWorkers) {
      const ctx = (rt.context ?? {}) as Record<string, unknown>;
      const origTaskId = ctx.reviewerFor as string | undefined;
      if (!origTaskId || !openTaskIdSet.has(origTaskId)) continue;
      const liveWorker = (rt as any).workers?.[0];
      if (liveWorker) {
        reviewerLiveMap.set(origTaskId, {
          reviewerWorkerId: liveWorker.id,
          reviewerRoleSlug: rt.roleSlug ?? null,
        });
      }
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  // Find reviewer_escalated and reviewer_approved notes for these tasks
  const allReviewerNotes = openTaskIds.length > 0
    ? await db.query.missionNotes.findMany({
        where: and(
          inArray(missionNotes.taskId, openTaskIds),
          inArray(missionNotes.type, ['reviewer_escalated', 'reviewer_approved']),
        ),
        columns: {
          taskId: true,
          type: true,
          title: true,
          body: true,
          status: true,
          supersededByPrNumber: true,
          createdAt: true,
        },
      })
    : [];

  // Build maps: taskId → escalation reason, taskId → approval summary
  const escalationMap = new Map<string, { reason: string; notedAt: Date }>();
  const approvalMap = new Map<string, { summary: string; notedAt: Date }>();
  const supersededTaskIds = new Set<string>();

  for (const note of allReviewerNotes) {
    if (!note.taskId) continue;

    if (note.status === 'superseded') {
      supersededTaskIds.add(note.taskId);
      continue;
    }
    if (note.status !== 'open') continue;

    if (note.type === 'reviewer_escalated' && !escalationMap.has(note.taskId)) {
      escalationMap.set(note.taskId, {
        reason: note.body ?? note.title,
        notedAt: note.createdAt,
      });
    }

    if (note.type === 'reviewer_approved' && !approvalMap.has(note.taskId)) {
      approvalMap.set(note.taskId, {
        summary: note.body ?? note.title,
        notedAt: note.createdAt,
      });
    }
  }

  // Load workspace gitConfigs for policy detection
  const uniqueWsIds = [...new Set(openPrWorkers.map(w => w.workspaceId))];
  const workspaceRows = await db.query.workspaces.findMany({
    where: inArray(workspaces.id, uniqueWsIds),
    columns: { id: true, name: true, gitConfig: true },
  });
  const wsMap = new Map(workspaceRows.map(ws => [ws.id, ws]));

  const agentReviewingTaskIds = new Set(reviewerLiveMap.keys());

  const items = openPrWorkers
    .filter(w => {
      if (w.prLifecycleStatus === 'closed' || w.prLifecycleStatus === 'merged') return false;
      const taskTitle = (w.task as any)?.title ?? '';
      if (taskTitle.startsWith('[smoke-test')) return false;
      if (w.taskId && supersededTaskIds.has(w.taskId)) return false;

      // Exclude items currently under an active agent-review lease
      if (w.taskId && agentReviewingTaskIds.has(w.taskId)) return false;

      if (w.taskId && escalationMap.has(w.taskId)) return true;
      // Include agent-approved items (approve-only gate) so the human can merge
      if (w.taskId && approvalMap.has(w.taskId)) return true;
      const ws = wsMap.get(w.workspaceId);
      if (!ws) return false;
      const policy = resolvePolicy(ws);
      return policy.tier === 'human';
    })
    .map(w => {
      const ws = wsMap.get(w.workspaceId);
      const escalation = w.taskId ? escalationMap.get(w.taskId) : undefined;
      const approval = w.taskId ? approvalMap.get(w.taskId) : undefined;
      const policy = ws ? resolvePolicy(ws) : { tier: 'auto-threshold' as const };
      const waitingMinutes = w.completedAt
        ? Math.round((Date.now() - new Date(w.completedAt).getTime()) / 60000)
        : null;

      const leaseState: 'agent_approved' | 'agent_flagged' | 'pending_human' =
        approval ? 'agent_approved'
        : escalation ? 'agent_flagged'
        : 'pending_human';

      return {
        workerId: w.id,
        taskId: w.taskId,
        taskTitle: (w.task as any)?.title ?? '',
        missionId: (w.task as any)?.missionId ?? null,
        workspaceId: w.workspaceId,
        workspaceName: ws?.name ?? '',
        prNumber: w.prNumber,
        prUrl: w.prUrl,
        policyTier: policy.tier,
        leaseState,
        escalationReason: escalation?.reason ?? (policy.tier === 'human' ? 'Human Gate — manual merge required' : null),
        verdictSummary: approval?.summary ?? null,
        waitingMinutes,
      };
    });

  return NextResponse.json({ items, count: items.length });
}
