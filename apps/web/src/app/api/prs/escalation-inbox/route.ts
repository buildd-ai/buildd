/**
 * GET /api/prs/escalation-inbox
 *
 * Returns PRs requiring human action for the escalation inbox (BT-15).
 * Includes:
 * - PRs where the reviewer escalated (reviewer_escalated mission_note exists)
 * - PRs where workspace merge policy tier = 'human'
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

  // Find workers with open (unmerged) PRs in user's workspaces
  const openPrWorkers = await db.query.workers.findMany({
    where: and(
      inArray(workers.workspaceId, wsIds),
      isNotNull(workers.prUrl),
      isNull(workers.mergedAt),
    ),
    columns: {
      id: true,
      taskId: true,
      workspaceId: true,
      prUrl: true,
      prNumber: true,
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

  // Find reviewer_escalated notes for these tasks
  const openTaskIds = openPrWorkers.map(w => w.taskId).filter(Boolean) as string[];
  const escalatedNotes = openTaskIds.length > 0
    ? await db.query.missionNotes.findMany({
        where: and(
          inArray(missionNotes.taskId, openTaskIds),
          eq(missionNotes.type, 'reviewer_escalated'),
        ),
        columns: { taskId: true, title: true, body: true, createdAt: true },
      })
    : [];

  // Build a map: taskId → escalation reason
  const escalationMap = new Map<string, { reason: string; notedAt: Date }>();
  for (const note of escalatedNotes) {
    if (note.taskId && !escalationMap.has(note.taskId)) {
      escalationMap.set(note.taskId, {
        reason: note.body ?? note.title,
        notedAt: note.createdAt,
      });
    }
  }

  // Load workspace gitConfigs for human-tier detection
  const uniqueWsIds = [...new Set(openPrWorkers.map(w => w.workspaceId))];
  const workspaceRows = await db.query.workspaces.findMany({
    where: inArray(workspaces.id, uniqueWsIds),
    columns: { id: true, name: true, gitConfig: true },
  });
  const wsMap = new Map(workspaceRows.map(ws => [ws.id, ws]));

  // Filter to escalation-inbox items
  const items = openPrWorkers
    .filter(w => {
      if (w.taskId && escalationMap.has(w.taskId)) return true;
      const ws = wsMap.get(w.workspaceId);
      if (!ws) return false;
      const policy = resolvePolicy(ws);
      return policy.tier === 'human';
    })
    .map(w => {
      const ws = wsMap.get(w.workspaceId);
      const escalation = w.taskId ? escalationMap.get(w.taskId) : undefined;
      const policy = ws ? resolvePolicy(ws) : { tier: 'auto-threshold' as const };
      const waitingMinutes = w.completedAt
        ? Math.round((Date.now() - new Date(w.completedAt).getTime()) / 60000)
        : null;

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
        escalationReason: escalation?.reason ?? (policy.tier === 'human' ? 'Human Gate — manual merge required' : null),
        waitingMinutes,
      };
    });

  return NextResponse.json({ items, count: items.length });
}
