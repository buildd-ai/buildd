/**
 * Claim-time required routes for a `[surface audit]` task.
 *
 * The description's "Required routes" block is written once, when the audit is
 * filed; the completion gate recomputes the list from the audit's current
 * `dependsOn` (`auditRequiredRoutes`). An auditor that captured exactly what
 * its description said was then refused. This block states the list the gate
 * will check, computed at claim. Best-effort: a failure attaches nothing.
 */
import type { ClaimTasksResponse } from '@buildd/shared';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { auditRequiredRoutes } from '@/lib/visual-qa-required-routes';
import { appendContextBlock } from './context-injection';
import { sqlWhere } from '@buildd/core/db/relational-sql';

export const VISUAL_AUDIT_ROUTES_CONTEXT_KEY = 'visualAuditRequiredRoutes';

type AuditTask = { id: string; roleSlug?: string | null; dependsOn?: unknown; context?: unknown };

/** The prompt block. Null with no routes: the description's own fallback stands. */
export function renderVisualAuditRoutes(routes: readonly string[]): string | null {
  if (routes.length === 0) return null;
  return [
    '## Required routes (computed at claim)',
    "Completion checks this list, recomputed from the audit's current dependencies. Where it differs from the description's \"Required routes\", this list wins. Capture each at mobile AND desktop, in light AND dark.",
    ...routes.map((r) => `- \`${r}\``),
  ].join('\n');
}

export async function attachVisualAuditRoutes(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly AuditTask[],
): Promise<void> {
  for (const cw of claimedWorkers) {
    const task = claimedTasks.find((t) => t.id === cw.taskId);
    if (!task || task.roleSlug !== VISUAL_AUDITOR_ROLE_SLUG) continue;
    try {
      const deps = Array.isArray(task.dependsOn) ? (task.dependsOn as string[]) : [];
      const depRows = deps.length > 0
        ? await db.query.tasks.findMany({ where: sqlWhere(inArray(tasks.id, deps)), columns: { pathManifest: true, title: true, context: true } })
        : [];
      const routes = auditRequiredRoutes({ context: task.context }, depRows);
      const block = renderVisualAuditRoutes(routes);
      if (!block) continue;
      const taskObj = cw.task as any;
      if (taskObj) {
        taskObj.context = taskObj.context ?? {};
        taskObj.context[VISUAL_AUDIT_ROUTES_CONTEXT_KEY] = routes;
      }
      appendContextBlock(cw, block);
    } catch (err) {
      console.warn('[claim] visual audit routes injection failed:', err);
    }
  }
}
