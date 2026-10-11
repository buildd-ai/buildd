/**
 * A task's PR link (`context.prReach`): which PRs a task may act on beyond
 * the one its own worker opened, stamped by the server when the task is filed.
 *
 * Read by `taskLinksPr` (lib/agent-capabilities/pr-ownership.ts), which the
 * close, update, merge, review-request and supersede doors consult for an
 * agent run. A coordination task that repairs a PR it never opened ("resolve
 * conflicts on #42") reaches that PR through this link.
 *
 * Who may link what, decided once, at filing:
 *   - a person (dashboard, chat, an OAuth MCP session): any PR the filing
 *     names (`#N` / `/pull/N` in the title or description, `context.prNumber`,
 *     `context.prNumbers`). It is their call, recorded as `human:<userId>`.
 *   - an agent run (a per-task token, or a runner key with a validated
 *     `createdByWorkerId`): only PRs its own task may already act on (its own
 *     worker's PR, a PR its own records link, or, for an orchestration task, a
 *     PR of its own mission), recorded as `task:<taskId>`. A link can pass on
 *     reach; it never creates any.
 *   - anything else (a plain API key, a webhook): no link.
 *
 * A caller-supplied `context.prReach` is always replaced; a template copied
 * into an unattended task drops it (`withoutPrReachGrant`).
 */
import { db } from '@buildd/core/db';
import { isOrchestrationTask } from '@buildd/shared';
import { prNumbersNamedAtFiling, taskLinksPr, type PrReachGrant } from '@/lib/agent-capabilities/pr-links';

export type PrReachFiler =
  | { kind: 'person'; personId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'none' };

export interface PrReachDeps {
  /** May the filing task already act on `prNumber` in `workspaceId`? */
  taskReachesPr?: (taskId: string, workspaceId: string, prNumber: number) => Promise<boolean>;
}

/** A context with any `prReach` removed. Never a different shape otherwise. */
export function withoutPrReachGrant<T>(context: T): T {
  if (!context || typeof context !== 'object' || Array.isArray(context) || !('prReach' in context)) return context;
  const { prReach: _dropped, ...rest } = context as Record<string, unknown>;
  return rest as T;
}

/**
 * The `prReach` link a new task gets, or null for none. `context` is the
 * caller's context as filed (its own `prReach`, if any, is ignored).
 */
export async function resolvePrReachGrant(
  filing: { title?: string | null; description?: string | null; context?: unknown; workspaceId: string },
  filer: PrReachFiler,
  deps: PrReachDeps = {},
  now: Date = new Date(),
): Promise<PrReachGrant | null> {
  if (filer.kind === 'none') return null;
  const candidates = prNumbersNamedAtFiling({ ...filing, context: withoutPrReachGrant(filing.context) });
  if (candidates.length === 0) return null;
  let prNumbers: number[];
  if (filer.kind === 'person') {
    prNumbers = candidates;
  } else {
    const reaches = deps.taskReachesPr ?? taskReachesPr;
    prNumbers = [];
    for (const n of candidates) {
      if (await reaches(filer.taskId, filing.workspaceId, n).catch(() => false)) prNumbers.push(n);
    }
  }
  if (prNumbers.length === 0) return null;
  return {
    prNumbers,
    grantedBy: filer.kind === 'person' ? `human:${filer.personId}` : `task:${filer.taskId}`,
    grantedAt: now.toISOString(),
  };
}

/**
 * May this task's agent run already act on `prNumber`? The same rule as
 * `agentRunMayActOnPr`: its own worker's PR, a PR its own records link, or,
 * for an orchestration task, a PR of another task on its own mission.
 */
export async function taskReachesPr(taskId: string, workspaceId: string, prNumber: number): Promise<boolean> {
  const task = await db.query.tasks.findFirst({
    where: (t, { eq }) => eq(t.id, taskId),
    columns: {
      id: true, workspaceId: true, missionId: true, roleSlug: true, mode: true, context: true,
      reviewerRetryPrNumber: true, ciRetryPrNumber: true, conflictRetryPrNumber: true,
    },
  });
  if (!task || task.workspaceId !== workspaceId) return false;
  if (taskLinksPr(task, prNumber)) return true;
  const own = await db.query.workers.findFirst({
    where: (w, { and, eq }) => and(eq(w.taskId, taskId), eq(w.workspaceId, workspaceId), eq(w.prNumber, prNumber)),
    columns: { id: true },
  });
  if (own) return true;
  if (!isOrchestrationTask(task) || !task.missionId) return false;
  // Loaded on use: worker-pr's import graph is wide, and the task-filing route
  // only needs it for an orchestration task naming a PR.
  const { missionOfPr } = await import('@/lib/agent-capabilities/worker-pr');
  return (await missionOfPr(workspaceId, prNumber)) === task.missionId;
}
