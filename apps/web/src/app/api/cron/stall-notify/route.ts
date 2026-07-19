/**
 * POST /api/cron/stall-notify
 *
 * BT-11 / BT-19: Stall notification cron.
 *
 * Runs periodically (recommended: every 5 minutes). For each PR in the
 * escalation inbox that has been waiting longer than stallNotifyMinutes,
 * sends a Pushover reminder — at most once per stall window.
 *
 * "Once per stall window" is tracked by inserting a `warning` mission_note
 * with title "[stall-notify] PR #N". If such a note exists within the current
 * stall window, we skip.
 *
 * Auth: Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import {
  workers,
  tasks,
  workspaces,
  missionNotes,
  missions,
} from '@buildd/core/db/schema';
import { eq, and, inArray, isNotNull, isNull, gte, like } from 'drizzle-orm';
import { resolvePolicy } from '@/lib/merge-policy';
import { notify } from '@/lib/pushover';

export const maxDuration = 60;
const DEFAULT_STALL_MINUTES = 30;

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Find all workers with open (unmerged) PRs
  const openPrWorkers = await db.query.workers.findMany({
    where: and(
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
        columns: { id: true, missionId: true },
      },
    },
  });

  if (openPrWorkers.length === 0) {
    return NextResponse.json({ ok: true, notified: 0, checked: 0 });
  }

  // Load workspaces for policy resolution
  const uniqueWsIds = [...new Set(openPrWorkers.map(w => w.workspaceId))];
  const workspaceRows = await db.query.workspaces.findMany({
    where: inArray(workspaces.id, uniqueWsIds),
    columns: { id: true, repo: true, gitConfig: true },
  });
  const wsMap = new Map(workspaceRows.map(ws => [ws.id, ws]));

  // Find tasks with reviewer_escalated notes
  const taskIds = openPrWorkers.map(w => w.taskId).filter(Boolean) as string[];
  const escalatedNoteTaskIds = new Set<string>();
  if (taskIds.length > 0) {
    const escalatedNotes = await db.query.missionNotes.findMany({
      where: and(
        inArray(missionNotes.taskId, taskIds),
        eq(missionNotes.type, 'reviewer_escalated'),
      ),
      columns: { taskId: true },
    });
    for (const n of escalatedNotes) {
      if (n.taskId) escalatedNoteTaskIds.add(n.taskId);
    }
  }

  let notified = 0;
  const now = Date.now();

  for (const worker of openPrWorkers) {
    const ws = wsMap.get(worker.workspaceId);
    if (!ws) continue;

    const policy = resolvePolicy(ws);
    const isEscalated = worker.taskId ? escalatedNoteTaskIds.has(worker.taskId) : false;
    const isHumanGate = policy.tier === 'human';

    // Only process PRs in the escalation inbox
    if (!isEscalated && !isHumanGate) continue;

    // Determine stall threshold
    const stallMinutes = policy.stallNotifyMinutes ?? DEFAULT_STALL_MINUTES;
    const stallMs = stallMinutes * 60 * 1000;

    // Use completedAt (when task completed and PR was opened) as stall start
    const prStartAt = worker.completedAt ? new Date(worker.completedAt).getTime() : null;
    if (!prStartAt) continue;

    const waitingMs = now - prStartAt;
    if (waitingMs < stallMs) continue; // Not yet stalled

    // Check if we already notified within this stall window
    const missionId = (worker.task as any)?.missionId;
    const windowStart = new Date(now - stallMs);
    if (missionId) {
      const recentStallNote = await db.query.missionNotes.findFirst({
        where: and(
          eq(missionNotes.missionId, missionId),
          eq(missionNotes.type, 'warning'),
          like(missionNotes.title, `[stall-notify] PR #${worker.prNumber}%`),
          gte(missionNotes.createdAt, windowStart),
        ),
        columns: { id: true },
      });
      if (recentStallNote) continue; // Already notified in this window
    }

    // Send Pushover reminder
    const waitingMinutes = Math.round(waitingMs / 60000);
    notify({
      app: 'alerts',
      title: `PR #${worker.prNumber} waiting ${waitingMinutes}m`,
      message: `PR #${worker.prNumber} on ${ws.repo ?? worker.workspaceId} has been waiting ${waitingMinutes} minutes for your review`,
      url: worker.prUrl ?? undefined,
      urlTitle: 'View PR',
    });

    // Record stall notification so we don't repeat within this window
    if (missionId) {
      await db.insert(missionNotes).values({
        missionId,
        taskId: worker.taskId,
        authorType: 'system',
        type: 'warning',
        title: `[stall-notify] PR #${worker.prNumber} — ${waitingMinutes}m stall reminder sent`,
        status: 'open',
      });
    }

    notified++;
  }

  return NextResponse.json({
    ok: true,
    checked: openPrWorkers.length,
    notified,
  });
}
