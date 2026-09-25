import { db } from '@buildd/core/db';
import { tasks, missions } from '@buildd/core/db/schema';
import { and, eq, like } from 'drizzle-orm';
import {
  SURFACE_AUDIT_TITLE_PREFIX,
  buildSurfaceAuditDescription,
  isSurfaceAuditTask,
  surfaceAuditTitle,
  touchesUiSurface,
} from '@buildd/core/surface-audit';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { visualQaRequiredRoutes } from '@/lib/visual-qa-required-routes';
import type { WorkspaceWebhookConfig } from '@buildd/core/db/schema';

export interface EnsureSurfaceAuditParams {
  missionId: string;
  workspaceId: string;
  createdTask: {
    id: string;
    title: string;
    taskClass: string | null;
    pathManifest: string[] | null;
  };
  targetWorkspace: {
    id?: string;
    name?: string;
    repo?: string | null;
    webhookConfig?: WorkspaceWebhookConfig | null;
    githubInstallationId?: string | null;
    githubRepoId?: string | null;
  };
}

/**
 * Ensure a mission whose builder tasks touch a UI surface directory
 * (apps/web/src/app/**, apps/web/src/components/**) has exactly one
 * `[surface audit]` task, gated on every builder task in the mission.
 *
 * Called from POST /api/tasks after every task creation under a mission —
 * that single choke point covers the dashboard, the API, and MCP
 * `create_task` (including organizer/heartbeat decomposition passes), since
 * all three route through the same endpoint.
 *
 * Idempotent by construction: an existing audit task (found by title prefix)
 * is extended, never duplicated. Best-effort under concurrent task creation —
 * matches this codebase's existing check-then-act conventions elsewhere in
 * this route (neon-http does not support interactive transactions).
 */
export async function ensureMissionSurfaceAudit(params: EnsureSurfaceAuditParams): Promise<void> {
  const { missionId, workspaceId, createdTask, targetWorkspace } = params;

  // Only a real builder deliverable can trigger or extend the audit — never
  // chase our own tail, and never count bookkeeping rows (mission organizer
  // tasks, friction reports, etc.) as "builder work".
  if (createdTask.taskClass !== 'work') return;
  if (isSurfaceAuditTask(createdTask.title)) return;

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, title: true, autoSurfaceAudit: true },
  });
  if (!mission || mission.autoSurfaceAudit === false) return;

  const existingAudit = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.missionId, missionId),
      like(tasks.title, `${SURFACE_AUDIT_TITLE_PREFIX}%`),
    ),
    columns: { id: true, dependsOn: true },
  });

  if (existingAudit) {
    // Rule 3: any later builder task extends the existing audit's dependsOn
    // (not just UI-touching ones — the audit reviews the mission's whole
    // shipped surface, which a backend-only task can still change).
    const currentDeps = Array.isArray(existingAudit.dependsOn) ? existingAudit.dependsOn : [];
    if (!currentDeps.includes(createdTask.id)) {
      await db.update(tasks)
        .set({ dependsOn: [...currentDeps, createdTask.id], updatedAt: new Date() })
        .where(eq(tasks.id, existingAudit.id));
    }
    return;
  }

  // No audit task yet — only mint one when THIS filing is what crosses the
  // UI-surface threshold. A non-UI builder task in an otherwise-backend
  // mission must not spin one up on its own.
  if (!touchesUiSurface(createdTask.pathManifest)) return;

  const builderTasks = await db.query.tasks.findMany({
    where: and(
      eq(tasks.missionId, missionId),
      eq(tasks.taskClass, 'work'),
    ),
    columns: { id: true, title: true, pathManifest: true },
  });
  const nonAuditBuilderTasks = builderTasks.filter(t => !isSurfaceAuditTask(t.title));
  const dependsOn = nonAuditBuilderTasks.map(t => t.id);
  const scopedPaths = Array.from(new Set(
    nonAuditBuilderTasks
      .flatMap(t => (Array.isArray(t.pathManifest) ? t.pathManifest : []))
      .filter(p => p !== '**'),
  ));

  const [auditTask] = await db.insert(tasks).values({
    workspaceId,
    missionId,
    title: surfaceAuditTitle(mission.title),
    description: buildSurfaceAuditDescription({
      missionTitle: mission.title,
      scopedPaths,
      requiredRoutes: visualQaRequiredRoutes(scopedPaths),
    }),
    taskClass: 'work',
    dependsOn,
    outputRequirement: 'artifact_required',
    // An explicit role slug: only a runner that found a working browser
    // advertises it (claim/role-gate.ts), so the audit can't be done from the
    // diff by a runner that can't render a page.
    roleSlug: VISUAL_AUDITOR_ROLE_SLUG,
  }).returning();

  if (auditTask) {
    await dispatchNewTask(auditTask, targetWorkspace, {}).catch(err =>
      console.error('[mission-surface-audit] dispatch failed:', err),
    );
  }
}
