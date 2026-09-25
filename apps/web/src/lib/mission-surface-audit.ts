import { db } from '@buildd/core/db';
import { tasks, missions, missionNotes } from '@buildd/core/db/schema';
import { and, desc, eq, like } from 'drizzle-orm';
import {
  MAX_SURFACE_AUDIT_ROUNDS,
  SURFACE_AUDIT_TITLE_PREFIX,
  buildSurfaceAuditDescription,
  isSurfaceAuditTask,
  isSurfaceFixTask,
  planSurfaceFixFollowUp,
  surfaceAuditRound,
  surfaceAuditTitle,
  surfaceFixRoute,
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
 * is extended, never duplicated. The one exception is a `[surface fix]` task
 * filed after the latest audit has already looked: that opens the next
 * re-check round, at most MAX_SURFACE_AUDIT_ROUNDS in all (followUpSurfaceFix). Best-effort under concurrent task creation —
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

  // Newest first: after a waiting-input retry clone or a later round there is
  // more than one audit, and the one that matters is the latest.
  const existingAudit = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.missionId, missionId),
      like(tasks.title, `${SURFACE_AUDIT_TITLE_PREFIX}%`),
    ),
    columns: { id: true, title: true, status: true, dependsOn: true, context: true },
    orderBy: [desc(tasks.createdAt)],
  });

  if (existingAudit && isSurfaceFixTask(createdTask.title)) {
    // A `[surface fix]` task is the auditor's (or a human's) answer to an
    // issue. Once the latest audit has looked, depending on the fix is inert,
    // so the re-check is a new round, bounded by MAX_SURFACE_AUDIT_ROUNDS.
    await followUpSurfaceFix({
      missionId,
      workspaceId,
      missionTitle: mission.title,
      fixTask: createdTask,
      latestAudit: existingAudit,
      targetWorkspace,
    });
    return;
  }

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function frozenRoutes(context: unknown): string[] {
  const vq = isRecord(context) && isRecord(context.visualQa) ? context.visualQa : null;
  return vq && Array.isArray(vq.requiredRoutes)
    ? vq.requiredRoutes.filter((r): r is string => typeof r === 'string')
    : [];
}

export const SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE =
  `Visual review: issues remain after ${MAX_SURFACE_AUDIT_ROUNDS} audit rounds`;

/**
 * Route a new `[surface fix]` task to the right audit round.
 *
 * - latest audit still `pending`: depend on the fix (and, for a later round,
 *   add the fix's route to the round's frozen route list);
 * - latest audit already looked, rounds left: insert ONE next-round audit,
 *   depending on the fix and scoped to its route. Later fixes from the same
 *   round find that pending audit and take the branch above;
 * - no rounds left: one open mission question for a human. The fix task
 *   itself stays open and holds the mission (pending_deliverables), so the
 *   answer is "fix it" or "cancel it to waive".
 *
 * A round skips the touchesUiSurface check: a fix task's manifest often names
 * no UI path, and the route in its title is what needs re-checking.
 */
async function followUpSurfaceFix(opts: {
  missionId: string;
  workspaceId: string;
  missionTitle: string;
  fixTask: EnsureSurfaceAuditParams['createdTask'];
  latestAudit: { id: string; title: string; status: string; dependsOn: unknown; context: unknown };
  targetWorkspace: EnsureSurfaceAuditParams['targetWorkspace'];
}): Promise<void> {
  const { missionId, workspaceId, missionTitle, fixTask, latestAudit, targetWorkspace } = opts;
  const round = surfaceAuditRound(latestAudit);
  const route = surfaceFixRoute(fixTask.title);
  const plan = planSurfaceFixFollowUp({ status: latestAudit.status, round });

  if (plan.action === 'extend') {
    const currentDeps = Array.isArray(latestAudit.dependsOn) ? (latestAudit.dependsOn as string[]) : [];
    const deps = currentDeps.includes(fixTask.id) ? currentDeps : [...currentDeps, fixTask.id];
    const routes = frozenRoutes(latestAudit.context);
    const nextRoutes = round > 1 && route && !routes.includes(route) ? [...routes, route].sort() : routes;
    if (deps === currentDeps && nextRoutes === routes) return;
    const ctx = isRecord(latestAudit.context) ? latestAudit.context : {};
    await db.update(tasks)
      .set({
        dependsOn: deps,
        ...(nextRoutes !== routes
          ? { context: { ...ctx, visualQa: { ...(isRecord(ctx.visualQa) ? ctx.visualQa : {}), requiredRoutes: nextRoutes } } }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, latestAudit.id));
    return;
  }

  if (plan.action === 'escalate') {
    // One question per mission while it is open: a round files several fixes.
    const existing = await db.query.missionNotes.findFirst({
      where: and(
        eq(missionNotes.missionId, missionId),
        eq(missionNotes.title, SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE),
        eq(missionNotes.status, 'open'),
      ),
      columns: { id: true },
    });
    if (existing) return;
    await db.insert(missionNotes).values({
      missionId,
      taskId: fixTask.id,
      authorType: 'system',
      actorLabel: `surface audit round cap (${MAX_SURFACE_AUDIT_ROUNDS})`,
      type: 'question',
      title: SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE,
      body: [
        `Audit round ${plan.roundsRun} still found an issue and filed "${fixTask.title}" (task ${fixTask.id}).`,
        `No further automatic audit round will open. The fix task holds this mission open: let it run and check the result yourself, or cancel it to waive the issue.`,
      ].join('\n\n'),
      status: 'open',
    });
    return;
  }

  const scopedPaths = (Array.isArray(fixTask.pathManifest) ? fixTask.pathManifest : []).filter(p => p !== '**');
  const requiredRoutes = route ? [route] : [];
  const [auditTask] = await db.insert(tasks).values({
    workspaceId,
    missionId,
    title: surfaceAuditTitle(missionTitle, plan.round),
    description: buildSurfaceAuditDescription({
      missionTitle,
      scopedPaths,
      requiredRoutes: [...new Set([...requiredRoutes, ...visualQaRequiredRoutes(scopedPaths)])].sort(),
      round: plan.round,
    }),
    taskClass: 'work',
    dependsOn: [fixTask.id],
    outputRequirement: 'artifact_required',
    roleSlug: VISUAL_AUDITOR_ROLE_SLUG,
    // The round is authoritative in context (the retry clone keeps context);
    // the frozen routes are unioned into the evidence check's required set.
    context: { surfaceAuditRound: plan.round, visualQa: { requiredRoutes } },
  }).returning();

  if (auditTask) {
    await dispatchNewTask(auditTask, targetWorkspace, {}).catch(err =>
      console.error('[mission-surface-audit] dispatch failed:', err),
    );
  }
}
