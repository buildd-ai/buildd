/**
 * The reads `/api/subscriptions` needs about a watch's subject before it asks
 * `createSubscription` (lib/subscriptions.ts) to write one: does the task
 * exist and is it still running; which GitHub repo a workspace's PR number
 * lives in (the github_repos FK only, never the free-text workspaces.repo),
 * and whether that PR already merged; and a readable label per watch.
 *
 * Visibility is not decided here. `createSubscription` re-checks that the
 * owner can see the subject's workspace and writes nothing otherwise.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { githubRepos, tasks, workers, workspaces } from '@buildd/core/db/schema';
import type { Subscription } from './subscriptions';

export const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export async function taskSubject(taskId: string): Promise<{ id: string; title: string; status: string; workspaceId: string } | null> {
  const t = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, title: true, status: true, workspaceId: true },
  });
  return t ? { id: t.id, title: t.title, status: t.status, workspaceId: t.workspaceId } : null;
}

export type PrSubject =
  | { ok: true; repoFullName: string; merged: boolean; title: string | null }
  | { ok: false; reason: 'no_workspace' | 'no_repo' };

export async function prSubject(workspaceId: string, prNumber: number): Promise<PrSubject> {
  const [ws] = await db.select({ id: workspaces.id, repo: githubRepos.fullName })
    .from(workspaces)
    .leftJoin(githubRepos, eq(githubRepos.id, workspaces.githubRepoId))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!ws) return { ok: false, reason: 'no_workspace' };
  if (!ws.repo) return { ok: false, reason: 'no_repo' };
  const rows = await db.select({ mergedAt: workers.mergedAt, title: tasks.title })
    .from(workers)
    .leftJoin(tasks, eq(tasks.id, workers.taskId))
    .where(and(eq(workers.workspaceId, workspaceId), eq(workers.prNumber, prNumber)))
    .limit(5);
  return {
    ok: true,
    repoFullName: ws.repo,
    merged: rows.some(r => r.mergedAt != null),
    title: rows.find(r => r.title)?.title ?? null,
  };
}

/** "Checkout rounding", "PR #42 · acme/widgets": one label per watch, for lists. */
export async function watchLabels(subs: readonly Subscription[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const taskIds = subs.filter(s => s.subjectKind === 'task').map(s => s.subjectKey);
  const titles = new Map<string, string>();
  if (taskIds.length) {
    const rows = await db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(inArray(tasks.id, taskIds));
    for (const r of rows) titles.set(r.id, r.title);
  }
  for (const s of subs) {
    if (s.subjectKind === 'task') out.set(s.id, titles.get(s.subjectKey) ?? 'a task');
    else {
      const ref = s.subjectRef as { repo?: string; number?: number };
      out.set(s.id, `PR #${ref.number ?? '?'}${ref.repo ? ` · ${ref.repo}` : ''}`);
    }
  }
  return out;
}
