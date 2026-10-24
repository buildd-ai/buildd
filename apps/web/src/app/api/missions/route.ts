import { MISSION_SUMMARY_COLUMNS, missionReadOptions, missionSummaryResponse } from '@/lib/mission-read-shape';
import { readMissionSummaries, refreshMissionSummary } from '@/lib/mission-summary-store';
import { listCallerKey, teamChangeScope, withChangeVersion } from '@/lib/change-version';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, workspaces, taskSchedules, initiatives, type WorkspaceGitConfig } from '@buildd/core/db/schema';
import { resolveBranchStrategy, isValidBranchStrategy, BRANCH_STRATEGIES } from '@buildd/core/branch-strategy';
import { generateMissionBranchName } from '@buildd/core/branch-names';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveMissionCreator } from '@/lib/task-service';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds, resolveAccountTeamIds } from '@/lib/team-access';
import { resolveWorkspaceAccess } from '@/lib/workspace-access';
import { checkContextArtifactIds } from '@/lib/context-artifact-ids';
import { computeNextRunAt } from '@/lib/schedule-helpers';
import { runMission } from '@/lib/mission-run';
import {
  ensureMissionIntegrationBranch,
  missionBranchRemedy,
  reportMissionBranchUnresolved,
} from '@/lib/mission-integration-branch';
import { resolveFeedActor, postMissionFeedEvent } from '@/lib/mission-feed';
import { computeMissionProgress, handWrittenCriteriaRefusal, validateGoalCriteria } from '@buildd/core/mission-helpers';
import { parseMergePolicy, findRemovedPathFieldInMergePolicy, removedPolicyPathFieldError, type LivingSpecGoalCriterion } from '@buildd/shared';
import {
  DEFAULT_HEARTBEAT_CRON,
  organizerChecklist,
} from '@/lib/heartbeat-helpers';
import { wouldCreateCycle } from '@/lib/mission-dependency';
import { maybePostWorkTrackerNote } from '@/lib/work-tracker';
import { laterStartAt, resolveDeferredStart } from '@/lib/deferred-start';
import { getTeamTimezone } from '@/lib/team-timezone';
import { GATE_SLUGS, fireGateEventForWorkspaceRef, gateCallerOrigin } from '@/lib/gate-ledger';
import { buildMissionListWhere, missionListOrderBy, parseMissionListSort } from '@/lib/mission-list-query';
import { sqlOrderBy, sqlOrderByFn, sqlWhere } from '@buildd/core/db/relational-sql';
import { settleWorkChanges } from '@/lib/settle-work-changes';
import { noteWorkChanged } from '@/lib/work-changed';
import { parseCreateSelections, resolveCreateSelections, startCreateSelections } from '@/lib/specs/mission-selection';

// GET /api/missions — list missions for the user's team(s)
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Resolved fresh on every read, never cached: a team removal drops the team's missions from the very next read.
    const caller = `teams:${apiAccount ? listCallerKey({ account: apiAccount }) : listCallerKey({ userId: user!.id })}`;
    const teamIds = await resolveAccountTeamIds(user, apiAccount);

    if (teamIds.length === 0) {
      return NextResponse.json({ missions: [] });
    }

    const { searchParams } = new URL(req.url);
    const statusFilter = searchParams.get('status');
    const workspaceIdFilter = searchParams.get('workspaceId');
    const teamIdFilter = searchParams.get('teamId');

    // Scope to a single team when requested. A teamId the caller is not a member
    // of yields an empty list — never another team's missions.
    let scopedTeamIds = teamIds;
    if (teamIdFilter) {
      if (!teamIds.includes(teamIdFilter)) {
        return NextResponse.json({ missions: [] });
      }
      scopedTeamIds = [teamIdFilter];
    }

    // R-20/R-35: listed by team, so versioned on each team's scope. Unchanged since
    // this caller's last read → 304, or the cached body, before any mission row is read.
    return await withChangeVersion(req, { scopes: scopedTeamIds.map(teamChangeScope), caller }, async () => {
    const { details, limit } = missionReadOptions(searchParams);
    const q = searchParams.get('q');
    const where = buildMissionListWhere({
      teamIds: scopedTeamIds,
      status: statusFilter,
      workspaceId: workspaceIdFilter,
      q,
    });

    if (!details) {
      const rows = await db.query.missions.findMany({
        where: sqlWhere(where), columns: MISSION_SUMMARY_COLUMNS,
        with: { workspace: { columns: { id: true, name: true } } },
        orderBy: sqlOrderBy(missionListOrderBy(parseMissionListSort(searchParams.get('sort')), q)),
        limit: limit + 1,
      });
      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      const [summaries, total] = await Promise.all([
        readMissionSummaries(page.map(r => r.id), page.flatMap(r => r.workspaceId ? [r.workspaceId] : []), { includeWorkspaceless: page.some(r => !r.workspaceId) }),
        hasMore ? db.$count(missions, where) : page.length,
      ]);
      return NextResponse.json({
        missions: page.map(row => ({ ...missionSummaryResponse(row, summaries.get(row.id)?.summary ?? null), workspace: row.workspace ?? null })),
        total, hasMore,
      });
    }

    const results = await db.query.missions.findMany({
      where: sqlWhere(where),
      orderBy: sqlOrderBy(missionListOrderBy(parseMissionListSort(searchParams.get('sort')), q)),
      limit,
      with: {
        workspace: { columns: { id: true, name: true } },
        tasks: {
          columns: { id: true, status: true, kind: true, title: true, mode: true, category: true, parentTaskId: true, creationSource: true, updatedAt: true, taskClass: true },
          with: { workers: { columns: { id: true, status: true, prUrl: true, mergedAt: true, prLifecycleStatus: true, supersededByPrNumber: true, abandonedAt: true }, orderBy: sqlOrderByFn((w: any, { desc }: any) => [desc(w.startedAt)]), limit: 1 } },
        },
        schedule: { columns: { cronExpression: true, nextRunAt: true, lastRunAt: true, lastDeferralReason: true, lastDeferredAt: true } },
      },
    });

    const missionsWithProgress = results.map(mission => {
      const { totalTasks, completedTasks, progress, segments } = computeMissionProgress(mission.tasks || []);
      const activeAgents = mission.tasks?.reduce((count, t) =>
        count + (t.workers?.filter((w: any) => w.status === 'running').length || 0), 0) || 0;
      const cronExpression = (mission as any).schedule?.cronExpression ?? null;
      const lastRunAt = (mission as any).schedule?.lastRunAt ?? null;
      const nextRunAt = (mission as any).schedule?.nextRunAt ?? null;
      const lastDeferralReason = (mission as any).schedule?.lastDeferralReason ?? null;
      const lastDeferredAt = (mission as any).schedule?.lastDeferredAt ?? null;

      // lastActivityAt: most recent task update or lastTaskStartedAt — whichever is newer
      const taskTimes = (mission.tasks || []).map(t => (t as any).updatedAt ? new Date((t as any).updatedAt).getTime() : 0);
      const lastTaskStartedMs = mission.lastTaskStartedAt ? new Date(mission.lastTaskStartedAt).getTime() : 0;
      const lastActivityMs = Math.max(0, ...taskTimes, lastTaskStartedMs);
      const lastActivityAt = lastActivityMs > 0 ? new Date(lastActivityMs).toISOString() : null;
      // completedAt: proxy via updatedAt when status is completed/archived
      const completedStatuses = ['completed', 'archived', 'budget_exhausted'];
      const completedAt = completedStatuses.includes(mission.status) ? mission.updatedAt.toISOString() : null;

      return {
        ...mission,
        totalTasks,
        completedTasks,
        progress,
        segments,
        activeAgents,
        cronExpression,
        lastRunAt,
        nextRunAt,
        lastDeferralReason,
        lastDeferredAt,
        lastActivityAt,
        completedAt,
        createdAt: mission.createdAt.toISOString(),
        updatedAt: mission.updatedAt.toISOString(),
      };
    });

    // total: how many match before the cap, so a capped page can say "N of M".
    const total = limit && results.length >= limit ? await db.$count(missions, where) : results.length;
    return NextResponse.json({ missions: missionsWithProgress, total });
    });
  } catch (error) {
    console.error('List missions error:', error);
    return NextResponse.json({ error: 'Failed to list missions' }, { status: 500 });
  }
}

// POST /api/missions — create mission
export async function POST(req: NextRequest) {
  // Read-your-writes (spec 3ef37387 R-20): the change version moves before this answers.
  // The body is deliberately not re-indented, so this stays a small diff.
  try {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (apiAccount && !hasTokenRouteAdminAccess(apiAccount, req)) {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { title, description, workspaceId, teamId: requestedTeamId, cronExpression, priority, parentMissionId, initiativeId, skillSlugs, outputSchema, model,
      isHeartbeat, heartbeatChecklist, activeHoursStart, activeHoursEnd, activeHoursTimezone, contextArtifactIds, maxConcurrentTasks, requiresReview, backend,
      status: requestedStatus, dependsOnMission, gateCondition, mergePolicy, orchestrationMode, costBudgetUsd,
      goalCriteria, autoVerify, branchStrategy, autoSurfaceAudit,
      startAt: rawStartAt, startIn: rawStartIn, startAfter: rawStartAfter, startMode, executor, decomposition, createdByWorkerId, outcomeSpec } = body;

    if (autoSurfaceAudit !== undefined && typeof autoSurfaceAudit !== 'boolean') {
      return NextResponse.json({ error: 'autoSurfaceAudit must be a boolean' }, { status: 400 });
    }

    const gateCaller = gateCallerOrigin({ apiAccount, user });

    if (branchStrategy !== undefined && branchStrategy !== null && !isValidBranchStrategy(branchStrategy)) {
      const error = `Invalid branchStrategy: must be one of ${BRANCH_STRATEGIES.join(', ')}`;
      fireGateEventForWorkspaceRef(workspaceId, {
        gate: GATE_SLUGS.BRANCH_STRATEGY,
        surface: 'POST /api/missions',
        outcome: 'rejected',
        reason: error,
        callerOrigin: gateCaller,
        detail: { op: 'create', value: String(branchStrategy).slice(0, 80) },
      });
      return NextResponse.json({ error }, { status: 400 });
    }

    let deferredStart;
    try {
      deferredStart = resolveDeferredStart({
        startAt: rawStartAt,
        startIn: rawStartIn,
        startAfter: rawStartAfter,
        knownBudgetResetAt: backend === 'codex' ? null : apiAccount?.budgetResetsAt ?? null,
      });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid deferred start' }, { status: 400 });
    }

    const validStatuses = ['active', 'paused', 'completed', 'archived'];
    if (requestedStatus !== undefined && !validStatuses.includes(requestedStatus)) {
      return NextResponse.json({ error: `Invalid status: must be one of ${validStatuses.join(', ')}` }, { status: 400 });
    }
    const effectiveStatus: 'active' | 'paused' | 'completed' | 'archived' = requestedStatus || 'active';

    const validOrchestrationModes = ['auto', 'manual'];
    if (orchestrationMode !== undefined && !validOrchestrationModes.includes(orchestrationMode)) {
      return NextResponse.json({ error: `Invalid orchestrationMode: must be "auto" or "manual"` }, { status: 400 });
    }
    const effectiveOrchestrationMode: 'auto' | 'manual' = orchestrationMode || 'auto';

    // Let the creator say up front that they're filing the task chain
    // themselves, instead of relying on runMission()'s pre-filed-task
    // heuristic to catch it reactively (which it cannot: that check runs
    // inside THIS request, before the creator has had a chance to file
    // anything — see the decomposition re-check gate in POST /api/tasks).
    const validDecompositionModes = ['auto', 'none'];
    if (decomposition !== undefined && !validDecompositionModes.includes(decomposition)) {
      return NextResponse.json({ error: `Invalid decomposition: must be "auto" or "none"` }, { status: 400 });
    }
    const decompositionSkippedAtCreate = decomposition === 'none';

    const validStartModes = ['armed', 'held'];
    if (startMode !== undefined && !validStartModes.includes(startMode)) {
      return NextResponse.json({ error: `Invalid startMode: must be "armed" or "held"` }, { status: 400 });
    }
    const effectiveIsHeld = startMode === 'held';

    // Who executes the tasks: background runners (default) or a person's local
    // session. Orthogonal to startMode — held still pauses a local mission.
    if (executor !== undefined && executor !== 'runner' && executor !== 'local') {
      return NextResponse.json({ error: 'Invalid executor: must be "runner" or "local"' }, { status: 400 });
    }

    if (!title) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }

    const defaultBackend: 'claude' | 'codex' | null =
      backend === 'claude' || backend === 'codex' ? backend : null;

    if (maxConcurrentTasks !== undefined && maxConcurrentTasks !== null && (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 1 || maxConcurrentTasks > 20)) {
      return NextResponse.json({ error: 'maxConcurrentTasks must be an integer between 1 and 20' }, { status: 400 });
    }



    if (gateCondition !== undefined && gateCondition !== 'merged' && gateCondition !== 'completed') {
      return NextResponse.json({ error: 'gateCondition must be "merged" or "completed"' }, { status: 400 });
    }

    if (mergePolicy !== undefined && mergePolicy !== null) {
      const removedField = findRemovedPathFieldInMergePolicy(mergePolicy);
      if (removedField) {
        return NextResponse.json({ error: removedPolicyPathFieldError(removedField), field: removedField }, { status: 400 });
      }
      const parsed = parseMergePolicy(mergePolicy);
      if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: 422 });
      }
    }

    if (goalCriteria !== undefined && goalCriteria !== null) {
      // Living Specs D-44: a new mission holds no hand-written criteria, so it
      // may not start any. Its completion bar is the spec it selects.
      const criteriaError = handWrittenCriteriaRefusal(undefined, goalCriteria) ?? validateGoalCriteria(goalCriteria);
      if (criteriaError) {
        // Includes the notMechanizableReason requirement on prose criteria —
        // the gate most likely to be rewriting how people phrase a mission.
        fireGateEventForWorkspaceRef(workspaceId, {
          gate: GATE_SLUGS.GOAL_CRITERIA,
          surface: 'POST /api/missions',
          outcome: 'rejected',
          reason: criteriaError,
          callerOrigin: gateCaller,
          detail: {
            op: 'create',
            criteriaCount: Array.isArray(goalCriteria) ? goalCriteria.length : null,
          },
        });
        return NextResponse.json({ error: criteriaError }, { status: 400 });
      }
    }

    // Living Specs D-41: the mission selects the specs it makes true, each
    // scoped (by default to what the selected revision adds or changes).
    // Parsed here, resolved once the workspace is known, stored with the row.
    const createSelections = outcomeSpec === undefined || outcomeSpec === null ? null : parseCreateSelections(outcomeSpec);
    if (createSelections && !createSelections.ok) {
      return NextResponse.json({ error: createSelections.error }, { status: 400 });
    }
    if (createSelections && goalCriteria !== undefined && goalCriteria !== null) {
      return NextResponse.json({ error: 'Send outcomeSpec or goalCriteria, not both: the outcome spec writes its own criterion' }, { status: 400 });
    }
    if (createSelections && !workspaceId) {
      return NextResponse.json({ error: 'outcomeSpec needs workspaceId: a mission selects specs of the workspace it builds in' }, { status: 400 });
    }

    if (activeHoursStart !== undefined && activeHoursStart !== null && (activeHoursStart < 0 || activeHoursStart > 23)) {
      return NextResponse.json({ error: 'activeHoursStart must be between 0 and 23' }, { status: 400 });
    }
    if (activeHoursEnd !== undefined && activeHoursEnd !== null && (activeHoursEnd < 0 || activeHoursEnd > 23)) {
      return NextResponse.json({ error: 'activeHoursEnd must be between 0 and 23' }, { status: 400 });
    }

    let teamId: string;
    let userTeamIds: string[] = [];
    if (apiAccount) {
      teamId = apiAccount.teamId;
    } else {
      userTeamIds = await getUserTeamIds(user!.id);
      if (userTeamIds.length === 0) {
        return NextResponse.json({ error: 'No team found' }, { status: 400 });
      }
      // Use requested teamId if provided and user belongs to that team
      if (requestedTeamId && userTeamIds.includes(requestedTeamId)) {
        teamId = requestedTeamId;
      } else {
        teamId = userTeamIds[0];
      }
    }

    let workspaceGitConfig: WorkspaceGitConfig | null = null;
    let resolvedWorkspaceId: string | null = null;
    if (workspaceId) {
      // Same reach rule as workspace listing and task creation
      // (lib/workspace-access.ts): an account reaches its own team's open
      // workspaces plus its explicit links — never another team's open
      // workspace; a user reaches their teams' workspaces.
      const access = await resolveWorkspaceAccess(
        String(workspaceId),
        apiAccount ? { account: apiAccount } : { userId: user!.id },
        'canCreate',
      );
      if (!access.ok) {
        return NextResponse.json({ error: access.error }, { status: access.status });
      }
      const ws = access.workspace;
      // Workspace is the stronger signal — derive team from it
      teamId = ws.teamId;
      resolvedWorkspaceId = ws.id;
      workspaceGitConfig = (ws.gitConfig as WorkspaceGitConfig | null) ?? null;
    }

    // Workspace-level default for a NEW mission's git workflow, or an explicit
    // per-mission override (MCP/API `branchStrategy`, validated above). Resolved
    // once, here, at create time only — an existing mission's own
    // integrationBranchEnabled stays the runtime truth from then on (see
    // missionIntegrationBase()).
    const effectiveBranchStrategy = branchStrategy ?? resolveBranchStrategy(workspaceGitConfig);
    const integrationBranchEnabled = effectiveBranchStrategy === 'mission-branch';

    // Cycle guard for dependency chain
    if (dependsOnMission) {
      // We don't have the new mission's ID yet — no cycle possible on create since it's new.
      // But we still validate that the upstream mission exists in the same team.
      const upstream = await db.query.missions.findFirst({
        where: sqlWhere(eq(missions.id, dependsOnMission)),
        columns: { id: true, teamId: true },
      });
      if (!upstream || upstream.teamId !== teamId) {
        return NextResponse.json({ error: 'dependsOnMission not found' }, { status: 404 });
      }
    }

    // Optional parent initiative — must be accessible to the caller (any of their teams).
    // teamId here is derived from the workspace; use callerTeamIds to allow cross-workspace linking.
    if (initiativeId) {
      const init = await db.query.initiatives.findFirst({
        where: sqlWhere(eq(initiatives.id, initiativeId)),
        columns: { id: true, teamId: true },
      });
      const callerTeamIds = apiAccount ? [apiAccount.teamId] : userTeamIds;
      if (!init || !callerTeamIds.includes(init.teamId)) {
        return NextResponse.json({ error: 'initiative not found or not accessible to your team' }, { status: 404 });
      }
    }

    const contextArtifacts = await checkContextArtifactIds(
      contextArtifactIds,
      apiAccount ? { account: apiAccount } : { userId: user!.id },
      teamId,
    );
    if (!contextArtifacts.ok) {
      return NextResponse.json({ error: contextArtifacts.error }, { status: 400 });
    }

    let selections: Array<{ criterion: LivingSpecGoalCriterion; inScope: string[] }> = [];
    if (createSelections && resolvedWorkspaceId) {
      const resolved = await resolveCreateSelections(resolvedWorkspaceId, createSelections.entries);
      if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
      selections = resolved.selections;
    }

    // Who filed it and who it is for, kept apart (spec 7702c32a R-1/R-2).
    const creator = await resolveMissionCreator({
      user,
      apiAccount,
      createdByWorkerId: typeof createdByWorkerId === 'string' ? createdByWorkerId : undefined,
    });

    const [mission] = await db
      .insert(missions)
      .values({
        teamId,
        title,
        description: description || null,
        workspaceId: resolvedWorkspaceId,
        status: effectiveStatus,
        priority: priority || 0,
        parentMissionId: parentMissionId || null,
        initiativeId: initiativeId || null,
        contextArtifactIds: contextArtifacts.ids,
        maxConcurrentTasks: maxConcurrentTasks ?? null,
        ...creator,
        orchestrationMode: effectiveOrchestrationMode,
        ...(decompositionSkippedAtCreate ? { decompositionSkipped: true } : {}),
        isHeld: effectiveIsHeld,
        ...(effectiveIsHeld ? {} : { armedAt: new Date() }),
        ...(executor ? { executor } : {}),
        integrationBranchEnabled,
        ...(defaultBackend ? { defaultBackend } : {}),
        ...(requiresReview === true ? { requiresReview: true } : {}),
        ...(dependsOnMission ? { dependsOnMissionId: dependsOnMission, gateCondition: gateCondition || 'merged' } : {}),
        ...(mergePolicy != null ? { mergePolicy } : {}),
        ...(costBudgetUsd != null ? { costBudgetUsd: String(costBudgetUsd) } : {}),
        ...(selections.length ? { goalCriteria: selections.map((x) => x.criterion) } : goalCriteria !== undefined ? { goalCriteria: goalCriteria ?? null } : {}),
        ...(autoVerify !== undefined ? { autoVerify: autoVerify === true ? true : autoVerify === false ? false : null } : {}),
        ...(autoSurfaceAudit !== undefined ? { autoSurfaceAudit } : {}),
        ...(deferredStart.startAt ? {
          startAt: deferredStart.startAt,
          startResolution: deferredStart.resolution,
        } : {}),
      })
      .returning();
    // Stored summary, and through it the mission lists' change version (R-13, R-20).
    refreshMissionSummary(mission.id);
    // Bumped before the response too (settleWorkChanges), so the creator's next list read sees it.
    noteWorkChanged({ missionIds: [mission.id] });

    // Every new auto mission gets a check-in (heartbeat) schedule by default.
    // Events plan its next step as work finishes; the check-in is the hourly
    // stuck check that dispatches the organizer only when that chain broke
    // (lib/mission-stuck.ts), so it costs no model call otherwise.
    // `isHeartbeat: false` opts out. A UI-created manual mission (no explicit
    // cron/heartbeat) gets none: manual means the owner starts things.
    // API-created missions keep their existing default (heartbeat ON).
    const uiCreatedManual = !apiAccount && !cronExpression && isHeartbeat === undefined
      && effectiveOrchestrationMode === 'manual';
    const effectiveHeartbeat = uiCreatedManual ? false : (isHeartbeat !== false);
    const effectiveCron = cronExpression || (effectiveHeartbeat ? DEFAULT_HEARTBEAT_CRON : null);

    // neon-http has no interactive transactions, so the schedule is created
    // BEFORE any outward side effect (branch, feed notes) and a failure here
    // deletes the mission row: otherwise the client sees a 500, retries, and
    // ends up with duplicate missions.
    let createdScheduleId: string | null = null;
    if (effectiveCron) {
    try {
        // Mission crons run on the team's wall clock: "every morning" has to mean
        // morning where the team is. Existing schedules keep their stored zone.
        const scheduleTimezone = await getTeamTimezone(teamId);
        const nextRunAt = laterStartAt(computeNextRunAt(effectiveCron, scheduleTimezone), deferredStart.startAt);
        const templateContext: Record<string, unknown> = {};
        if (skillSlugs?.length) templateContext.skillSlugs = skillSlugs;
        if (outputSchema) templateContext.outputSchema = outputSchema;
        if (model) templateContext.model = model;
        if (effectiveHeartbeat) {
          templateContext.heartbeat = true;
          templateContext.heartbeatChecklist = heartbeatChecklist || organizerChecklist();
        }
        if (activeHoursStart != null) templateContext.activeHoursStart = activeHoursStart;
        if (activeHoursEnd != null) templateContext.activeHoursEnd = activeHoursEnd;
        if (activeHoursTimezone) templateContext.activeHoursTimezone = activeHoursTimezone;

        const [schedule] = await db
          .insert(taskSchedules)
          .values({
            workspaceId: resolvedWorkspaceId,
            name: `Mission: ${title}`,
            cronExpression: effectiveCron,
            timezone: scheduleTimezone,
            taskTemplate: {
              title: `Mission: ${title}`,
              mode: 'planning',
              priority: priority || 0,
              ...(Object.keys(templateContext).length > 0 ? { context: templateContext } : {}),
            },
            nextRunAt,
            // Only a person who filed the mission themselves names the schedule;
            // otherwise its tasks reach the person through the mission.
            createdByUserId: creator.requesterSource === 'explicit' ? creator.createdByUserId : null,
          })
          .returning();
        createdScheduleId = schedule.id;

        await db
          .update(missions)
          .set({ scheduleId: schedule.id, updatedAt: new Date() })
          .where(eq(missions.id, mission.id));

        mission.scheduleId = schedule.id;
    } catch (err) {
      if (createdScheduleId) {
        await db.delete(taskSchedules).where(eq(taskSchedules.id, createdScheduleId))
          .catch(e => console.error('[missions/post] Failed to roll back schedule:', e));
      }
      await db.delete(missions).where(eq(missions.id, mission.id))
        .catch(e => console.error('[missions/post] Failed to roll back mission:', e));
      throw err;
    }
    }

    // contextArtifactIds dual-write: the column keeps them for older readers, and
    // each id also becomes a `context` link (artifact_links, owned by Living
    // Specs), which mission context reads. Best-effort: a link that fails is
    // logged and the column still carries the id.
    if (contextArtifacts.ids.length) {
      try {
        const { linkContextArtifacts } = await import('@/lib/artifact-links');
        const { failed } = await linkContextArtifacts(
          apiAccount ? { kind: 'account', account: apiAccount } : { kind: 'user', userId: user!.id },
          'mission', mission.id, contextArtifacts.ids,
        );
        if (failed.length) console.warn('[missions/post] context links not written:', failed);
      } catch (err) {
        console.warn('[missions/post] context links not written:', err);
      }
    }

    if (selections.length) {
      await startCreateSelections(apiAccount ? { kind: 'account', account: apiAccount } : { kind: 'user', userId: user!.id }, mission.id, selections);
    }

    // A mission-branch mission must never exist in the enabled-but-inert state: generate the
    // working branch name and ensure the ref on the remote in this same operation, rather than
    // waiting for the organizer's first pass (see the two-manual-PATCH workaround this replaces).
    if (integrationBranchEnabled) {
      const workingBranch = generateMissionBranchName({ missionId: mission.id, title });
      await db
        .update(missions)
        .set({ workingBranch, updatedAt: new Date() })
        .where(eq(missions.id, mission.id));
      mission.workingBranch = workingBranch;

      // A mission with no workspace has no repo to cut the branch in YET — that
      // is not a failure, it is deferred: the first task filed into a
      // repo-linked workspace cuts it (POST /api/tasks), and create_pr re-cuts
      // it from the task's workspace as a last resort. Attempting it here only
      // produced a `no_repo` note that read as a dead end.
      const ensured = resolvedWorkspaceId
        ? await ensureMissionIntegrationBranch(mission.id).catch(err => ({
            ok: false as const,
            reason: 'api_error' as const,
            detail: err instanceof Error ? err.message : String(err),
          }))
        : { ok: true as const };
      if (!ensured.ok) {
        await reportMissionBranchUnresolved({
          missionId: mission.id,
          branch: workingBranch,
          where: 'mission_create',
          surface: 'POST /api/missions',
          cause: ensured.reason === 'not_opted_in' ? 'missing' : ensured.reason,
          fallback: 'none',
          detail: ensured.detail ?? null,
          workspaceId: resolvedWorkspaceId,
        });
        // Do not fail the create — the mission, flag, and branch name are all correct.
        // Say so where an operator will see it, exactly like the PATCH opt-in path does.
        const actor = await resolveFeedActor({ user, apiAccount });
        await postMissionFeedEvent({
          missionId: mission.id,
          type: 'update',
          title: 'Integration branch could not be created',
          body: `Option A′ is enabled for this mission, but its integration branch (\`${workingBranch}\`) could not be created on the remote (${ensured.reason}${ensured.detail ? `: ${ensured.detail}` : ''}). Task PRs fall back to trunk until this is resolved.\n\n**To fix:** ${missionBranchRemedy(ensured.reason)}`,
          actor,
        }).catch(e => console.error('[missions/post] Failed to emit integration-branch note:', e));
      }
    }

    // Auto-start the organizer only when the mission is born active, heartbeat is not disabled,
    // and orchestrationMode is 'auto'. Manual-mode missions require explicit human trigger.
    let organizerTask: { id: string } | null = null;
    if (effectiveStatus === 'active' && isHeartbeat !== false && effectiveOrchestrationMode === 'auto' && !deferredStart.startAt) {
      try {
        const result = await runMission(mission.id, { manualRun: true });
        if (result.task) organizerTask = { id: result.task.id };
      } catch (err) {
        console.error('Auto-start organizer failed (mission still created):', err);
      }
    }

    // Non-blocking: post a work-tracker suggestion note if the workspace has one configured
    if (resolvedWorkspaceId) {
      maybePostWorkTrackerNote(mission.id, resolvedWorkspaceId).catch(() => {});
    }

    // Build informative creation response
    const nextRunInfo = mission.scheduleId
      ? (() => {
          // Best-effort: include nextRunAt from the schedule we just created
          return effectiveOrchestrationMode === 'manual'
            ? 'Schedule configured but dormant — orchestrationMode is manual'
            : `Heartbeat enabled`;
        })()
      : null;

    const created = {
      ...mission,
      organizerTask,
      ...(deferredStart.startAt ? {
        startAt: deferredStart.startAt.toISOString(),
        startResolution: deferredStart.resolution,
      } : {}),
      ...(nextRunInfo ? { heartbeatInfo: nextRunInfo } : {}),
    };

    // No create-time goal-quality advisory: a new mission cannot carry
    // hand-written criteria (Living Specs D-44), so there is nothing to grade.
    // PATCH still grades edits on missions that already carry them.
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error('Create mission error:', error);
    return NextResponse.json({ error: 'Failed to create mission' }, { status: 500 });
  }
  } finally { await settleWorkChanges(); }
}
