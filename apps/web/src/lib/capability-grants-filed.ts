/**
 * Access declared when a task is filed (rules: packages/core/token-delegation.ts,
 * "Access declared at filing"). Agents declare, people grant — the same split
 * as `filingTargets` + `delegation`:
 *
 *  - the claim gate (`checkAccessGate`): a declared need that no filed grant
 *    and no auto-granting policy (role rule first, then team) covers holds the
 *    task (`access_unmet`) before any agent turn;
 *  - a person's grant (`setTaskFiledAccess`): written on the task's delegation,
 *    which each run (and each retry) turns into a capability grant on its first
 *    ask or query (capability-grants-store.ts). Taking it back revokes those;
 *  - Needs You (`filedAccessNeedsYouRead`): one card per task held for access,
 *    naming the task, the access and the reason; it opens the task page, where
 *    the grant is one click.
 *
 * Spec: docs/specs/capability-requests.md → Access declared at filing.
 */
import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import {
  ACCESS_NEEDS_CONTEXT_KEY,
  describeAccessGaps,
  findAccessGaps,
  readAccessNeeds,
  readTaskAccessGrants,
  stampTaskAccess,
  withTaskAccess,
  type TaskAccessGrant,
  type TaskAccessNeed,
  type TaskDelegation,
} from '@buildd/core/token-delegation';
import { effectivePolicy, type PolicyRule } from './capability-grants';
import { loadPolicyRules, revokeFiledGrants } from './capability-grants-store';
import { providerName } from './capability-grants-view';
import { clearCallerCache, callerDep } from './caller-cache';
import type { WaitingOnYouRawItem } from './action-queue';

// ── Claim gate ───────────────────────────────────────────────────────────────

export interface AccessGateResult {
  gaps: TaskAccessNeed[];
  detail: string;
}

/** Pure: does team policy auto-grant a read of this provider for this task's role? */
export function policyAutoGrantsRead(rules: readonly PolicyRule[], provider: string, workspaceId: string, roleSlug: string | null): boolean {
  return effectivePolicy(rules, { provider, risk: 'read', workspaceId, roleSlug, environment: null, resource: null }, false).effect === 'auto_grant';
}

/**
 * Claim pre-flight: the declared needs nothing covers. Null = start the run.
 * Not forceable: forcing would only start an agent that then asks mid-run.
 */
export async function checkAccessGate(
  task: { id: string; workspaceId: string; roleSlug?: string | null; delegation?: unknown; context?: unknown },
  loadRules: (teamId: string) => Promise<PolicyRule[]> = loadPolicyRules,
): Promise<AccessGateResult | null> {
  const needs = readAccessNeeds(task.context);
  if (!needs.length) return null;
  const grants = readTaskAccessGrants(task.delegation);
  if (!findAccessGaps(needs, grants, () => false).length) return null;
  const ws = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, task.workspaceId)), columns: { id: true, teamId: true } });
  const rules = ws?.teamId ? await loadRules(ws.teamId) : [];
  const gaps = findAccessGaps(needs, grants, p => policyAutoGrantsRead(rules, p, task.workspaceId, task.roleSlug ?? null));
  if (!gaps.length) return null;
  return { gaps, detail: describeAccessGaps(gaps) };
}

// ── A person grants (or takes back) ──────────────────────────────────────────

export type FiledAccessWrite =
  | { ok: true; access: TaskAccessGrant[]; revoked: number }
  | { ok: false; status: number; error: string };

/**
 * Replace a task's filed access with these needs, granted by `userId` (the
 * route has checked they hold manage_connectors in the task's team). `[]`
 * takes it all back. Every grant a run holds from a provider no longer filed
 * is revoked, so its next call is refused. The declared needs are kept as
 * they are (a need is not a grant). Optimistic lock, no transaction.
 */
export async function setTaskFiledAccess(taskId: string, needs: readonly TaskAccessNeed[], userId: string, now: Date = new Date()): Promise<FiledAccessWrite> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const task = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, taskId)), columns: { id: true, delegation: true, updatedAt: true } });
    if (!task) return { ok: false, status: 404, error: 'Task not found' };
    const current = task.delegation as TaskDelegation | null;
    // A provider already granted keeps who granted it and when.
    const kept = readTaskAccessGrants(current);
    const access = needs.map(n => {
      const prior = kept.find(g => g.provider === n.provider);
      return prior ? { ...prior, reason: n.reason ?? prior.reason } : stampTaskAccess([n], userId, now)[0];
    });
    const next = withTaskAccess(current, access, { userId, at: now });
    const [row] = await db.update(tasks)
      .set({ delegation: next, updatedAt: now })
      .where(and(eq(tasks.id, taskId), eq(tasks.updatedAt, task.updatedAt)))
      .returning({ id: tasks.id });
    if (row) {
      const revoked = await revokeFiledGrants(taskId, access.map(a => a.provider), now);
      await clearCallerCache(callerDep.task(taskId));
      return { ok: true, access, revoked };
    }
  }
  return { ok: false, status: 409, error: 'The task changed while the grant was being written; try again.' };
}

// ── Needs You ────────────────────────────────────────────────────────────────

/** Where a person grants a task's declared access. */
export const filedAccessHref = (taskId: string, baseUrl = '') => `${baseUrl}/app/tasks/${encodeURIComponent(taskId)}#task-filed-access`;

export interface FiledAccessTaskRow {
  id: string;
  title: string | null;
  workspaceId: string;
  workspaceName: string | null;
  roleSlug: string | null;
  context: unknown;
  delegation: unknown;
}

/** Pure: one card per task that declares access no person has granted. */
export function filedAccessNeedsYouItems(rows: readonly FiledAccessTaskRow[], baseUrl = ''): WaitingOnYouRawItem[] {
  const items: WaitingOnYouRawItem[] = [];
  for (const t of rows) {
    const gaps = findAccessGaps(readAccessNeeds(t.context), readTaskAccessGrants(t.delegation), () => false);
    if (!gaps.length) continue;
    const ask = gaps.map(g => `Read ${providerName(g.provider)}`).join(' · ');
    const why = gaps.map(g => g.reason?.trim()).filter(Boolean).map(r => `"${r}"`).join(' ');
    const who = t.title?.trim() || (t.roleSlug ? `A ${t.roleSlug} task` : 'A task');
    items.push({
      kind: 'access',
      accessFiledTaskId: t.id,
      accessAsk: ask,
      taskId: t.id,
      taskTitle: t.title ?? undefined,
      workspaceId: t.workspaceId,
      workspaceName: t.workspaceName ?? null,
      failureMessage: [`${who}${t.workspaceName ? ` in ${t.workspaceName}` : ''} was filed needing this and waits to start`, why || null].filter(Boolean).join(': '),
      fixHref: filedAccessHref(t.id, baseUrl),
      fixLabel: 'Grant',
    });
  }
  return items;
}

/**
 * Home's read for its batch: pending tasks in these workspaces that declare
 * access (newest first, at most 25). Only a viewer who can grant
 * (manage_connectors) asks. A task whose needs are all granted gets no card;
 * one a policy would auto-grant still shows until a person grants or the run
 * starts (the claim gate lets it through, so it leaves pending).
 */
export function filedAccessNeedsYouRead(workspaceIds: readonly string[]) {
  const query = db.select({
    id: tasks.id, title: tasks.title, workspaceId: tasks.workspaceId, workspaceName: workspaces.name,
    roleSlug: tasks.roleSlug, context: tasks.context, delegation: tasks.delegation,
  })
    .from(tasks)
    .leftJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
    .where(and(
      inArray(tasks.workspaceId, [...workspaceIds]),
      eq(tasks.status, 'pending'),
      sql`jsonb_typeof(${tasks.context} -> ${ACCESS_NEEDS_CONTEXT_KEY}) = 'array'`,
    ))
    .orderBy(desc(tasks.createdAt))
    .limit(25);
  type Row = Awaited<typeof query>[number];
  return {
    query,
    items: (rows: readonly Row[]): WaitingOnYouRawItem[] => filedAccessNeedsYouItems(rows as unknown as FiledAccessTaskRow[]),
  };
}
