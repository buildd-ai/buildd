import { db } from '@buildd/core/db';
import { tasks, missions, missionNotes, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, isNull, like } from 'drizzle-orm';
import {
  MAX_SURFACE_AUDIT_ROUNDS,
  SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE,
  SURFACE_AUDIT_TITLE_PREFIX,
  buildSurfaceAuditDescription,
  isSurfaceAuditTask,
  isSurfaceFixTask,
  planSurfaceFixFollowUp,
  surfaceAuditRound,
  surfaceAuditTitle,
  surfaceFixRoute,
  touchesUiSurface,
  type SurfaceAuditTrigger,
} from '@buildd/core/surface-audit';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { visualQaRequiredRoutes } from '@/lib/visual-qa-required-routes';
import { evaluateSurfaceAuditGate, loadSurfaceAuditGateTasks } from '@/lib/mission-surface-audit-gate';
import { missionMemberIds } from '@/lib/mission-surface-audit-membership';
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
    /** The filing workspace's team. A mission outside it is never written to. */
    teamId?: string | null;
    name?: string;
    repo?: string | null;
    webhookConfig?: WorkspaceWebhookConfig | null;
    githubInstallationId?: string | null;
    githubRepoId?: string | null;
  };
  /**
   * Who filed `createdTask`, for a `[surface fix]`: the pipeline (`auto`, the
   * default: the auditor or a person through POST /api/tasks) or a visual
   * review decision (`human`), which bypasses the automatic round cap under
   * MAX_TOTAL_SURFACE_AUDIT_ROUNDS (planSurfaceFixFollowUp).
   */
  origin?: SurfaceAuditTrigger;
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
  const { missionId, workspaceId, createdTask, targetWorkspace, origin = 'auto' } = params;

  // Only a real builder deliverable can trigger or extend the audit — never
  // chase our own tail, and never count bookkeeping rows (mission organizer
  // tasks, friction reports, etc.) as "builder work".
  if (createdTask.taskClass !== 'work') return;
  if (isSurfaceAuditTask(createdTask.title)) return;

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, title: true, autoSurfaceAudit: true, teamId: true },
  });
  if (!mission || mission.autoSurfaceAudit === false) return;
  // missionId comes from the request body. Every write below (audit insert,
  // dependsOn/route extension, round-cap question) lands in this mission, so
  // it must belong to the filing workspace's team. Fail closed when unknown.
  if (!targetWorkspace.teamId || mission.teamId !== targetWorkspace.teamId) return;

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
      origin,
    });
    return;
  }

  if (existingAudit) {
    // Rule 3: any later builder task extends the existing audit's dependsOn
    // (not just UI-touching ones — the audit reviews the mission's whole
    // shipped surface, which a backend-only task can still change).
    // The rewrite also drops a dependency that has left the mission since it
    // was added (an unlink that predates detachTaskFromMissionSurfaceAudits),
    // so the stored list is current membership, not a filing-time record.
    const currentDeps = Array.isArray(existingAudit.dependsOn) ? existingAudit.dependsOn : [];
    const members = await missionMemberIds(missionId, currentDeps);
    const nextDeps = members.includes(createdTask.id) ? members : [...members, createdTask.id];
    const changed = nextDeps.length !== currentDeps.length || nextDeps.some((d, i) => d !== currentDeps[i]);
    if (changed) {
      await db.update(tasks)
        .set({ dependsOn: nextDeps, updatedAt: new Date() })
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
    // Looking, not building: the work-kind glyph and the model router read it.
    kind: 'observation',
    dependsOn,
    outputRequirement: 'artifact_required',
    context: { surfaceAuditTrigger: 'auto' },
    // An explicit role slug: only a runner that found a working browser
    // advertises it (claim/role-gate.ts), so the audit can't be done from the
    // diff by a runner that can't render a page.
    roleSlug: VISUAL_AUDITOR_ROLE_SLUG,
  }).returning();

  if (auditTask) {
    await announceTaskCreated(auditTask, targetWorkspace).catch(err =>
      console.error('[mission-surface-audit] dispatch failed:', err),
    );
    await wakeTask(auditTask.id, 'task.created');
  }
}

export type RequestSurfaceAuditResult =
  | { ok: true; created: boolean; taskId: string; status: string }
  | { ok: false; reason: 'mission_not_found' | 'mission_closed' | 'no_workspace' };

const finishedWithoutLooking = (status: string) => status === 'failed' || status === 'cancelled';

type PlanMission = { id: string; title: string; status: string; workspaceId: string | null; autoSurfaceAudit: boolean | null; workingBranch: string | null; integrationBranchEnabled: boolean | null; executor: string | null };

export type SurfaceAuditPlan =
  | { ok: false; reason: 'mission_not_found' | 'mission_closed' | 'no_workspace' }
  /** An audit that is open or done already: it is the answer, nothing is derived. */
  | { ok: true; mission: PlanMission; live: { id: string; status: string }; targetWorkspace?: undefined; builderIds?: undefined; scopedPaths?: undefined; requiredRoutes?: undefined }
  | {
      ok: true;
      mission: PlanMission;
      live: null;
      targetWorkspace: typeof workspaces.$inferSelect;
      builderIds: string[];
      scopedPaths: string[];
      requiredRoutes: string[];
    };

/**
 * What a person's "Run visual review" would do, without doing it: the live
 * audit it would return, or the dependencies, files and routes a new one would
 * carry. `requestMissionSurfaceAudit` acts on this and the mission page's
 * Visual review sheet previews it, so the two cannot describe different audits.
 */
export async function planMissionSurfaceAudit(missionId: string): Promise<SurfaceAuditPlan> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: {
      id: true, title: true, status: true, workspaceId: true, autoSurfaceAudit: true,
      workingBranch: true, integrationBranchEnabled: true, executor: true,
    },
  }) as PlanMission | undefined;
  if (!mission) return { ok: false, reason: 'mission_not_found' };
  if (mission.status === 'completed' || mission.status === 'archived') return { ok: false, reason: 'mission_closed' };
  if (!mission.workspaceId) return { ok: false, reason: 'no_workspace' };

  const audits = await db.query.tasks.findMany({
    where: and(eq(tasks.missionId, missionId), like(tasks.title, `${SURFACE_AUDIT_TITLE_PREFIX}%`)),
    columns: { id: true, status: true },
    orderBy: [desc(tasks.createdAt)],
  });
  const live = audits.find(a => !finishedWithoutLooking(a.status));
  if (live) return { ok: true, mission, live: { id: live.id, status: live.status } };

  const [targetWorkspace, missionTasks] = await Promise.all([
    db.query.workspaces.findFirst({ where: eq(workspaces.id, mission.workspaceId) }),
    loadSurfaceAuditGateTasks(missionId),
  ]);
  if (!targetWorkspace) return { ok: false, reason: 'no_workspace' };

  const builders = missionTasks.filter(t =>
    t.taskClass === 'work' && !isSurfaceAuditTask(t.title ?? '') && !finishedWithoutLooking(t.status));
  const gate = await evaluateSurfaceAuditGate(mission, missionTasks).catch(() => null);
  const scopedPaths = Array.from(new Set([
    ...(gate?.required ? gate.uiPaths : []),
    ...builders.flatMap(t => (Array.isArray(t.pathManifest) ? t.pathManifest : [])).filter(p => p !== '**'),
  ]));
  return {
    ok: true,
    mission,
    live: null,
    targetWorkspace,
    builderIds: builders.map(t => t.id),
    scopedPaths,
    requiredRoutes: visualQaRequiredRoutes(scopedPaths),
  };
}

/**
 * A person asked for the mission's visual audit (the decision sheet's "Run
 * visual audit"). Idempotent: an audit that is open or finished is returned,
 * never duplicated; only a failed or cancelled one is replaced. The audit is
 * scoped to the files the mission actually changed (the completion gate's
 * diff read), because declared manifests are often the advisory wildcard.
 */
export async function requestMissionSurfaceAudit(missionId: string): Promise<RequestSurfaceAuditResult> {
  const plan = await planMissionSurfaceAudit(missionId);
  if (!plan.ok) return plan;
  const { mission, live, targetWorkspace, builderIds, scopedPaths, requiredRoutes } = plan;
  if (live) return { ok: true, created: false, taskId: live.id, status: live.status };

  const [auditTask] = await db.insert(tasks).values({
    workspaceId: targetWorkspace.id,
    missionId,
    title: surfaceAuditTitle(mission.title),
    description: buildSurfaceAuditDescription({
      missionTitle: mission.title,
      scopedPaths,
      requiredRoutes,
    }),
    taskClass: 'work',
    kind: 'observation',
    dependsOn: builderIds,
    outputRequirement: 'artifact_required',
    context: { surfaceAuditTrigger: 'auto' },
    roleSlug: VISUAL_AUDITOR_ROLE_SLUG,
  }).returning();

  await announceTaskCreated(auditTask, targetWorkspace).catch(err =>
    console.error('[mission-surface-audit] dispatch failed:', err),
  );
  await wakeTask(auditTask.id, 'task.created');
  return { ok: true, created: true, taskId: auditTask.id, status: auditTask.status };
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

// Lives in core so the visual review loader can read it without this module's db deps.
export { SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE };

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
  origin: SurfaceAuditTrigger;
}): Promise<void> {
  const { missionId, workspaceId, missionTitle, fixTask, latestAudit, targetWorkspace, origin } = opts;
  const round = surfaceAuditRound(latestAudit);
  const route = surfaceFixRoute(fixTask.title);
  const plan = planSurfaceFixFollowUp({ status: latestAudit.status, round }, { origin });

  // At the ceiling nothing opens. The decisions route checks this first and
  // answers 409, so a human fix never gets here in practice.
  if (plan.action === 'ceiling') return;

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
    // The round-cap question also reaches the conversation the mission was
    // filed from, once per audit (docs/design/visual-qa-human-review.md, Chat).
    await import('@/lib/chat/mission-events')
      .then(m => m.postVisualReviewEvent({ missionId, moment: 'round_cap', auditTaskId: latestAudit.id }))
      .catch(err => console.error('[surface-audit] chat event failed:', err));
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
      trigger: origin,
    }),
    taskClass: 'work',
    kind: 'observation',
    dependsOn: [fixTask.id],
    outputRequirement: 'artifact_required',
    roleSlug: VISUAL_AUDITOR_ROLE_SLUG,
    // The round is authoritative in context (the retry clone keeps context);
    // the frozen routes are unioned into the evidence check's required set.
    context: { surfaceAuditRound: plan.round, surfaceAuditTrigger: origin, visualQa: { requiredRoutes } },
  }).returning();

  if (auditTask) {
    await announceTaskCreated(auditTask, targetWorkspace).catch(err =>
      console.error('[mission-surface-audit] dispatch failed:', err),
    );
    await wakeTask(auditTask.id, 'task.created');
  }
}

export type DetachFixResult =
  | { action: 'none' }
  | { action: 'detached'; auditTaskId: string }
  | { action: 'cancelled'; auditTaskId: string };

/**
 * A `[surface fix]` was waived (cancelled by a human decision) or withdrawn
 * (an undo). If the mission's latest audit has not started, it must not
 * re-check a fix that will never land: re-shooting the unchanged page would
 * only file the same issue again.
 *
 * - The fix leaves the pending audit's `dependsOn`, and its route leaves the
 *   frozen route list unless another remaining fix names it.
 * - A later round left with no dependency re-checks nothing, so it is
 *   cancelled, only while still pending and unclaimed (atomic WHERE).
 * - Round 1 keeps its builder dependencies and just drops the fix.
 *
 * An audit that already started is never touched.
 */
export async function detachFixFromPendingAudit(opts: {
  missionId: string;
  workspaceId: string;
  fixTaskId: string;
  route: string | null;
}): Promise<DetachFixResult> {
  const { missionId, fixTaskId, route } = opts;
  const audit = await db.query.tasks.findFirst({
    where: and(eq(tasks.missionId, missionId), like(tasks.title, `${SURFACE_AUDIT_TITLE_PREFIX}%`)),
    columns: { id: true, title: true, status: true, dependsOn: true, context: true, workspaceId: true },
    orderBy: [desc(tasks.createdAt)],
  });
  if (!audit || audit.status !== 'pending') return { action: 'none' };
  const deps = Array.isArray(audit.dependsOn) ? (audit.dependsOn as string[]) : [];
  if (!deps.includes(fixTaskId)) return { action: 'none' };
  const remaining = deps.filter(d => d !== fixTaskId);
  const round = surfaceAuditRound(audit);

  if (round > 1 && remaining.length === 0) {
    const cancelled = await db.update(tasks)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(tasks.id, audit.id), eq(tasks.status, 'pending'), isNull(tasks.claimedBy)))
      .returning({ id: tasks.id });
    if (cancelled.length === 0) return { action: 'none' };
    const { applyTaskCancelSideEffects } = await import('@/lib/task-cancel');
    await applyTaskCancelSideEffects({ id: audit.id, workspaceId: audit.workspaceId ?? opts.workspaceId, missionId });
    return { action: 'cancelled', auditTaskId: audit.id };
  }

  const routes = frozenRoutes(audit.context);
  let nextRoutes = routes;
  if (route && routes.includes(route)) {
    const others = remaining.length > 0
      ? await db.query.tasks.findMany({ where: inArray(tasks.id, remaining), columns: { id: true, title: true } })
      : [];
    if (!others.some(t => surfaceFixRoute(t.title) === route)) nextRoutes = routes.filter(r => r !== route);
  }
  const ctx = isRecord(audit.context) ? audit.context : {};
  await db.update(tasks)
    .set({
      dependsOn: remaining,
      ...(nextRoutes !== routes
        ? { context: { ...ctx, visualQa: { ...(isRecord(ctx.visualQa) ? ctx.visualQa : {}), requiredRoutes: nextRoutes } } }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, audit.id), eq(tasks.status, 'pending')));
  return { action: 'detached', auditTaskId: audit.id };
}
