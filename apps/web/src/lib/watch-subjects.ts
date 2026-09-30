/**
 * The reads `/api/subscriptions` needs about a watch's subject before it asks
 * `createSubscription` (lib/subscriptions.ts) to write one: does the task
 * exist and is it still running; which GitHub repo a workspace's PR number
 * lives in (the github_repos FK only, never the free-text workspaces.repo),
 * and whether that PR already merged; and a readable label per watch.
 *
 * Visibility first: every lookup is scoped to the caller (a member of the
 * subject workspace's team, the same rule createSubscription applies to a
 * person owner). A subject the caller can't see reads exactly like one that
 * doesn't exist, so its status, repo link or merge state never leak.
 * `createSubscription` still re-checks at write time.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { githubRepos, tasks, teamMembers, workers, workspaces } from '@buildd/core/db/schema';
import type { Subscription } from './subscriptions';

export { TERMINAL_TASK_STATUSES } from '@buildd/shared';

/** The caller is a member of workspace `workspaces`' team. */
const callerSees = (userId: string) => sql`exists (select 1 from ${teamMembers} where ${teamMembers.teamId} = ${workspaces.teamId} and ${teamMembers.userId} = ${userId})`;

/** The task, only if the caller can see it; null otherwise (never "exists but hidden"). */
export async function taskSubject(taskId: string, userId: string): Promise<{ id: string; title: string; status: string; workspaceId: string } | null> {
  const [t] = await db.select({ id: tasks.id, title: tasks.title, status: tasks.status, workspaceId: tasks.workspaceId })
    .from(tasks)
    .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
    .where(and(eq(tasks.id, taskId), callerSees(userId)))
    .limit(1);
  return t ?? null;
}

export type PrSubject =
  | { ok: true; repoFullName: string; merged: boolean; title: string | null }
  | { ok: false; reason: 'not_found' | 'no_repo' };

/** A PR in a workspace the caller can see; `not_found` for one they can't, before anything else is read. */
export async function prSubject(workspaceId: string, prNumber: number, userId: string): Promise<PrSubject> {
  const [ws] = await db.select({ id: workspaces.id, repo: githubRepos.fullName })
    .from(workspaces)
    .leftJoin(githubRepos, eq(githubRepos.id, workspaces.githubRepoId))
    .where(and(eq(workspaces.id, workspaceId), callerSees(userId)))
    .limit(1);
  if (!ws) return { ok: false, reason: 'not_found' };
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
