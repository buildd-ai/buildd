/**
 * A task as a live chat object: its Board label, role, and the latest worker's
 * live state (runner, current action, PR).
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { count, desc, eq } from 'drizzle-orm';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { boardTaskLabel } from '@/lib/mission-board-label';
import { resolveRunnerDisplay } from '@/lib/runner-display';
import { findTaskRole } from '@/app/app/(protected)/tasks/[id]/role-lookup';
import { deriveNow, type Milestone } from '@/app/app/(protected)/tasks/[id]/task-activity';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import type { TaskObjectView } from '@/components/chat/objects/object-views';

const epoch = (v: Date | string | null | undefined): number | null => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

const LIVE = new Set<string>(LIVE_WORKER_STATUSES);

/** The task page's Now strip state for a live worker (as RealTimeWorkerView derives it); null otherwise. Pure. */
export function taskNowState(
  worker: { status: string; currentAction: string | null; prUrl: string | null; startedAt: number | null; milestones: unknown } | null,
  nowMs: number,
): TaskObjectView['now'] {
  if (!worker || !LIVE.has(worker.status)) return null;
  const milestones = Array.isArray(worker.milestones) ? (worker.milestones as Milestone[]) : [];
  return deriveNow(milestones, {
    status: worker.status,
    currentAction: worker.currentAction,
    prUrl: worker.prUrl,
    startMs: worker.startedAt,
    nowMs,
  });
}

// Bookkeeping around a question, not something that happened to the work.
const NOT_AN_EVENT = /^(Asked:|Question:|Answer received:|User:)/;

/**
 * WHAT HAPPENED in the desktop dock: the worker's labelled status and
 * checkpoint milestones, oldest first, the last `max`. Tool actions and phases
 * are the Now strip's business, not this list's. Pure.
 */
export function taskHappened(milestones: unknown, max = 4): Array<{ ts: number; text: string }> {
  if (!Array.isArray(milestones)) return [];
  return (milestones as Milestone[])
    .filter(m => (m.type === 'status' || m.type === 'checkpoint') && typeof m.ts === 'number' && !!m.label?.trim() && !NOT_AN_EVENT.test(m.label.trim()))
    .sort((a, b) => a.ts - b.ts)
    .slice(-max)
    .map(m => ({ ts: m.ts, text: m.label!.trim() }));
}

export async function loadTaskObject(taskId: string, userId: string): Promise<TaskObjectView | null> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    with: {
      workspace: { columns: { id: true, teamId: true } },
      mission: { columns: { id: true, title: true } },
    },
  });
  if (!task) return null;

  const [access, latest, role, runs] = await Promise.all([
    verifyWorkspaceAccess(userId, task.workspaceId),
    db.query.workers.findFirst({
      where: eq(workers.taskId, taskId),
      orderBy: desc(workers.createdAt),
      columns: {
        id: true, status: true, runner: true, startedAt: true, completedAt: true, currentAction: true,
        waitingFor: true, prNumber: true, prUrl: true, mergedAt: true, prLifecycleStatus: true, milestones: true,
        turns: true, updatedAt: true, error: true,
      },
    }),
    findTaskRole({ workspaceId: task.workspaceId, teamId: (task.workspace as { teamId?: string } | null)?.teamId, slug: task.roleSlug }),
    db.select({ n: count() }).from(workers).where(eq(workers.taskId, taskId)).then(r => Number(r[0]?.n ?? 0)).catch(() => null),
  ]);
  if (!access) return null;

  const { scope, label } = boardTaskLabel({ title: task.title, label: (task as { label?: string | null }).label ?? null });
  const renderedAt = Date.now();
  const now = latest ? taskNowState({
    status: latest.status,
    currentAction: latest.currentAction ?? null,
    prUrl: latest.prUrl ?? null,
    startedAt: epoch(latest.startedAt),
    milestones: latest.milestones,
  }, renderedAt) : null;
  return {
    kind: 'task',
    id: task.id,
    workspaceId: task.workspaceId,
    title: task.title,
    scope,
    label,
    status: task.status,
    roleName: role?.name ?? null,
    roleColor: role?.color ?? null,
    missionId: task.missionId ?? null,
    missionTitle: (task.mission as { title?: string } | null)?.title ?? null,
    worker: latest ? {
      id: latest.id,
      status: latest.status,
      runner: resolveRunnerDisplay({ runner: latest.runner })?.name ?? null,
      startedAt: epoch(latest.startedAt),
      completedAt: epoch(latest.completedAt),
      currentAction: latest.currentAction ?? null,
      waiting: !!latest.waitingFor,
      prNumber: latest.prNumber ?? null,
      prUrl: latest.prUrl ?? null,
      mergedAt: epoch(latest.mergedAt),
      prLifecycleStatus: latest.prLifecycleStatus ?? null,
      turns: latest.turns,
      updatedAt: epoch(latest.updatedAt),
    } : null,
    now,
    attempts: runs ?? (latest ? 1 : 0),
    waitingPrompt: latest?.waitingFor?.prompt ?? null,
    error: latest?.error ?? null,
    happened: latest ? taskHappened(latest.milestones) : [],
    renderedAt,
  };
}
