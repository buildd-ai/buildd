/**
 * Claim-time "Screens to re-shoot" for a `[surface audit]` task (spec 072de598
 * I-15). A merged fix's screen is re-checked only by a shot of the same route,
 * viewport and state, and an auditor reading the fix's route alone used to shoot
 * a sibling state and report "all ok". This block names each screen exactly,
 * from the mission's visual review model at claim. Best-effort: a failure
 * attaches nothing.
 */
import type { ClaimTasksResponse } from '@buildd/shared';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { renderRecaptureScreens } from '@buildd/core/surface-audit';
import { loadVisualReview } from '@/lib/visual-review-load';
import { recaptureScreenLabel } from '@/lib/workflow/visual-review-state';
import { appendContextBlock } from './context-injection';
import { sqlWhere } from '@buildd/core/db/relational-sql';

export const VISUAL_AUDIT_RECAPTURE_CONTEXT_KEY = 'visualAuditRecapture';

type AuditTask = { id: string; roleSlug?: string | null };

export async function attachVisualAuditRecapture(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly AuditTask[],
): Promise<void> {
  for (const cw of claimedWorkers) {
    const task = claimedTasks.find((t) => t.id === cw.taskId);
    if (!task || task.roleSlug !== VISUAL_AUDITOR_ROLE_SLUG) continue;
    try {
      const row = await db.query.tasks.findFirst({
        where: sqlWhere(eq(tasks.id, task.id)),
        columns: { missionId: true, workspaceId: true },
      });
      if (!row?.missionId) continue;
      const model = await loadVisualReview({ id: row.missionId, workspaceId: row.workspaceId });
      const screens = (model.recapture?.screens ?? []).map(recaptureScreenLabel);
      const block = renderRecaptureScreens([...new Set(screens)]);
      if (!block) continue;
      const taskObj = cw.task as any;
      if (taskObj) {
        taskObj.context = taskObj.context ?? {};
        taskObj.context[VISUAL_AUDIT_RECAPTURE_CONTEXT_KEY] = screens;
      }
      appendContextBlock(cw, block);
    } catch (err) {
      console.warn('[claim] visual audit recapture injection failed:', err);
    }
  }
}
