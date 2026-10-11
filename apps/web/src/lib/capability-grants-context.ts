/**
 * The words a person reads a capability request by: its task's title, its
 * workspace's name, and who decided it. Added to the rows `listTeamRequests`
 * returns (capability-grants-store.ts) for Settings → Agent access and Home.
 * Team-internal names only, never a credential. A failed read leaves them
 * blank rather than failing the list.
 */
import { db } from '@buildd/core/db';
import { capabilityGrants, tasks, users, workspaces } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';

export interface RequestContext {
  taskTitle: string | null;
  workspaceName: string | null;
  decidedByName: string | null;
}

const uniq = <T,>(xs: readonly (T | null | undefined)[]) => [...new Set(xs.filter((x): x is T => x != null))];

export async function withRequestContext<T extends { id: string; taskId: string; workspaceId: string }>(rows: readonly T[]): Promise<(T & RequestContext)[]> {
  if (rows.length === 0) return [];
  const taskIds = uniq(rows.map(r => r.taskId));
  const wsIds = uniq(rows.map(r => r.workspaceId));
  try {
    const [t, w, deciders] = await Promise.all([
      db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(inArray(tasks.id, taskIds)),
      db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(inArray(workspaces.id, wsIds)),
      db.select({ id: capabilityGrants.id, userId: capabilityGrants.decidedByUserId }).from(capabilityGrants).where(inArray(capabilityGrants.id, rows.map(r => r.id))),
    ]);
    const userIds = uniq(deciders.map(d => d.userId));
    const u = userIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [];
    const titles = new Map(t.map(x => [x.id, x.title]));
    const names = new Map(w.map(x => [x.id, x.name]));
    const userName = new Map(u.map(x => [x.id, x.name ?? null]));
    const decider = new Map(deciders.map(d => [d.id, d.userId ? userName.get(d.userId) ?? null : null]));
    return rows.map(r => ({ ...r, taskTitle: titles.get(r.taskId) ?? null, workspaceName: names.get(r.workspaceId) ?? null, decidedByName: decider.get(r.id) ?? null }));
  } catch (err) {
    console.warn('[capability-grants-context] read failed (non-fatal):', (err as Error)?.message ?? err);
    return rows.map(r => ({ ...r, taskTitle: null, workspaceName: null, decidedByName: null }));
  }
}
