import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, desc, inArray, sql } from 'drizzle-orm';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { listReachableWorkspaceIds } from '@/lib/workspace-access';
import { taskPrsFor } from '@/lib/workflow/task-pr';
import { getDeliveryViewsForTasks } from '@/lib/workflow/delivery-view';
import { parseThreadTarget, threadEventsFor, threadNote, needsYouNote } from '@/lib/task-thread-target';

/**
 * GET /api/tasks/thread-events?threadId=<id>
 *
 * The notes owed to one client thread (T3 Code via `buildd acp`): for every task the
 * caller can reach that remembers this thread as its callback target
 * (`context.callbackTarget`), the events it has reached, derived from its current
 * state. Read-only and idempotent: the caller keeps which `key`s it has shown, so a
 * missed poll is repaired by the next. Spec: docs/specs/acp-bridge.md (thread notes).
 */
export async function GET(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);
  const user = apiAccount ? null : await getCurrentUser();
  if (!apiAccount && !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const target = parseThreadTarget({ kind: 't3_thread', threadId: req.nextUrl.searchParams.get('threadId') ?? '' });
  if (!target) return NextResponse.json({ error: 'threadId required (1-128 characters)' }, { status: 400 });

  try {
    let workspaceIds = await listReachableWorkspaceIds(apiAccount ? { account: apiAccount } : { userId: user!.id });
    if (apiAccount) workspaceIds = workspaceIds.filter(id => taskScopeAllowsWorkspace(apiAccount, id));
    if (workspaceIds.length === 0) return NextResponse.json({ events: [] });

    const rows = await db.select({ id: tasks.id, title: tasks.title, status: tasks.status, dependsOn: tasks.dependsOn }).from(tasks).where(and(
      inArray(tasks.workspaceId, workspaceIds),
      sql`${tasks.context}->'callbackTarget'->>'kind' = 't3_thread'`,
      sql`${tasks.context}->'callbackTarget'->>'threadId' = ${target.threadId}`,
    )).orderBy(desc(tasks.createdAt)).limit(50);
    if (rows.length === 0) return NextResponse.json({ events: [] });

    const ids = rows.map(r => r.id);
    const latest = new Map<string, string>();
    const ws = await db.select({ taskId: workers.taskId, status: workers.status }).from(workers)
      .where(inArray(workers.taskId, ids)).orderBy(desc(workers.createdAt));
    for (const w of ws) if (w.taskId && !latest.has(w.taskId)) latest.set(w.taskId, w.status);
    const prs = await taskPrsFor(ids);
    // Owner-only states (kernel delivery needsYou), the task's own or its dependency's. Best effort:
    // a failed read drops the note, never the rest of the thread's events.
    const depIds = [...new Set(rows.flatMap(r => (r.status === 'pending' ? r.dependsOn ?? [] : [])))];
    const deliveries = await getDeliveryViewsForTasks([...ids, ...depIds]).catch(() => new Map());
    const depPrs = depIds.length > 0 ? await taskPrsFor(depIds).catch(() => new Map()) : new Map();

    const events = rows.flatMap(task => {
      const prUrl = prs.get(task.id)?.prUrl ?? null;
      const dependency = (task.status === 'pending' ? task.dependsOn ?? [] : [])
        .map((id: string) => ({ delivery: deliveries.get(id), prUrl: depPrs.get(id)?.prUrl ?? null }))
        .find((d: { delivery?: { needsYou: boolean } }) => d.delivery?.needsYou);
      const need = needsYouNote({ delivery: deliveries.get(task.id) ?? null, prUrl, dependency: dependency as never });
      const needEvents = need ? [{
        key: `${task.id}:needs_you:${need.reason}`, taskId: task.id, event: 'needs_you' as const, text: need.text,
        dashboardUrl: `https://buildd.dev/app/tasks/${task.id}`,
      }] : [];
      return [...threadEventsFor({
        taskStatus: task.status,
        workerStatus: latest.get(task.id) ?? null,
        prUrl,
        hasWorker: latest.has(task.id),
      }).map(event => ({
        key: `${task.id}:${event}`,
        taskId: task.id,
        event,
        text: threadNote(event, { title: task.title, prUrl }),
        dashboardUrl: `https://buildd.dev/app/tasks/${task.id}`,
      })), ...needEvents];
    });
    return NextResponse.json({ events });
  } catch (error) {
    console.error('thread-events failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
