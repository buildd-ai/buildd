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
      // Option A': which PR this is decides whether a human is the gate at all.
      // Null means unknown and resolves to today's gate, never to quarantined.
      prBaseRef: true,
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

  // Option A': a task PR based on a mission's integration branch is not that
  // mission's review gate — the single PR from that branch into trunk is — so it
  // must not page anyone. Only the two fields the base-ref rule reads are
  // selected: this cron has always resolved its policy from the workspace alone,
  // and feeding it mission-level mergePolicy or requiresReview would change
  // which PRs it pages about for reasons unrelated to integration branches.
  const missionIdsForPolicy = [
    ...new Set(
      openPrWorkers
        .map(w => (w.task as { missionId?: string | null } | null)?.missionId)
        .filter((id): id is string => !!id),
    ),
  ];
  const missionMap = new Map<string, { workingBranch: string | null; integrationBranchEnabled: boolean }>();
  if (missionIdsForPolicy.length > 0) {
    const missionRows = await db.query.missions.findMany({
      where: inArray(missions.id, missionIdsForPolicy),
      columns: { id: true, workingBranch: true, integrationBranchEnabled: true },
    });
    for (const m of missionRows) {
      missionMap.set(m.id, {
        workingBranch: m.workingBranch,
        // A NULL opt-in is not an opt-in.
        integrationBranchEnabled: m.integrationBranchEnabled ?? false,
      });
    }
  }

  // Find tasks with reviewer_escalated notes
  const taskIds = openPrWorkers.map(w => w.taskId).filter(Boolean) as string[];
  const escalatedNoteTaskIds = new Set<string>();
  if (taskIds.length > 0) {
    const escalatedNotes = await db.query.missionNotes.findMany({
      where: and(
        inArray(missionNotes.taskId, taskIds),
        eq(missionNotes.type, 'reviewer_escalated'),
        eq(missionNotes.status, 'open'),
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

    const workerMissionId = (worker.task as { missionId?: string | null } | null)?.missionId ?? null;
    const policy = resolvePolicy(
      ws,
      workerMissionId ? missionMap.get(workerMissionId) ?? null : null,
      null,
      { baseRef: worker.prBaseRef },
    );
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
    const missionId = workerMissionId;
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
