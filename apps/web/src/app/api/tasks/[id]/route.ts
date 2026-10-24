import { formatTaskEstimate } from '@buildd/shared';
import { taskEstimatePayload } from '@buildd/core/task-estimate-rollout';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { pauseRefusal, requestWorkerPause } from '@/lib/worker-pause';
import { parseCancellation } from '@/lib/task-cancellation';
import { rejectOverCeiling } from '@/lib/tier-ceiling-check';
import { BACKEND_PINNED_KEY } from '@buildd/core/backend-policy';
import { isTerminalTaskStatus, canDeleteTask, LIVE_WORKER_STATUSES } from '@buildd/shared';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers, artifacts } from '@buildd/core/db/schema';
import { and, eq, inArray, desc } from 'drizzle-orm';
import { requestingPerson } from '@/lib/request-person';
import { resolveTaskDelegationWrite } from '@/lib/task-delegation-checks';
import { emit } from '@/lib/core-emit';
import { noteWorkChanged } from '@/lib/work-changed';
import { isMissionLinkable } from '@/lib/mission-link-scope';
import { validateRequiredConnectors } from '@/lib/required-connectors';
import { lazyRequester } from '@buildd/core/role-visibility';
import { checkStatedRole } from '@/lib/stated-role';

const FULL_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateTaskId(id: string): NextResponse | null {
  if (FULL_UUID_REGEX.test(id)) return null;
  const isPrefix = /^[0-9a-f]{1,35}$/i.test(id);
  const error = isPrefix
    ? `taskId must be a full UUID — "${id}" looks like an ID prefix. The web UI shows 8-character prefixes; use the full UUID from the task URL or API response.`
    : `taskId must be a full UUID (e.g. b833be4b-1234-5678-abcd-ef0123456789) — received "${id}".`;
  return NextResponse.json({ error }, { status: 400 });
}
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { authenticateTaskScopedCaller, isOrchestrationTaskToken, taskScopeAllowsMissionTask, taskScopeAllowsMissionTaskRead, taskScopeAllowsTask } from '@/lib/task-token-auth';
import { withoutDispatchToken } from '@/lib/workspace-dispatch-token';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { resolveCompletedTask } from '@/lib/task-dependencies';
import { applyWaitExit, parseWaitOn } from '@/lib/task-wait-exit';
import { applyTaskCancelSideEffects, applyTaskDeleteSideEffects, emitTaskUpdated, endLiveWorkersForRequeue } from '@/lib/task-cancel';
import { checkDependencyCycle, checkDependencyReach, dependencyViewerOf } from '@/lib/task-dependency-reach';
import { loadQuestionWaits } from '@/lib/question-waits';
import { resolveDeferredStart } from '@/lib/deferred-start';
import { wakeTask } from '@/lib/dispatch-authority';
import { parseLoopConfig } from '@buildd/core/loop-config';
import { readModelPin, isTaskTier, isAcceptableModelPin } from '@buildd/core/model-pin';
import { TIERS } from '@buildd/core/model-tier-defaults';
import { appBaseUrl } from '@/lib/app-url';
import { TASK_RESERVATION_KEY, buildReservation } from '../../workers/claim/held-gate';
import { INTERACTIVE_SESSION_HEADER, verifyInteractiveSession } from '@/lib/interactive-session';
import { loadInlineEvidence } from '@/lib/evidence-inline';
import { dispatchHistoryForTask } from '@buildd/core/dispatch-outbox';
import { sqlExtras, sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { leanContextSql, leanResultSql, taskReadColumns, taskReadShape } from '@/lib/task-read-shape';
import { taskPrOf, withTaskPr } from '@/lib/workflow/task-pr';
import { settleWorkChanges } from '@/lib/settle-work-changes';
import { bumpChangeVersions, scopesOfDeletedTasks } from '@/lib/change-version';
import { clearCallerCache, callerDep } from '@/lib/caller-cache';
import { kernelPrincipalOf } from '@/lib/workflow/kernel-client';
import { isOwnScopeHold } from '@buildd/workflow-kernel/scope-hold';

/**
 * Label the wake for a task just reset to pending — but only when nothing it
 * dependsOn is still outstanding. The status write already made a wake durable
 * (outbox trigger, `task.requeued`); this records it as a manual start and
 * kicks delivery. Mirrors checkDependsOnResolved's rule (every dep completed,
 * looping deps satisfied) minus its open-PR check; the claim route still
 * enforces the merged-PR gate.
 */
async function wakeIfDependenciesSatisfied(task: typeof tasks.$inferSelect): Promise<void> {
  const deps = (task.dependsOn as string[] | null) ?? [];
  if (deps.length > 0) {
    const depRows = await db.query.tasks.findMany({
      where: sqlWhere(inArray(tasks.id, deps)),
      columns: { id: true, status: true, loopState: true },
    });
    const byId = new Map(depRows.map((d) => [d.id, d]));
    const satisfied = deps.every((depId) => {
      const dep = byId.get(depId);
      return dep?.status === 'completed' && (dep.loopState == null || dep.loopState === 'satisfied');
    });
    if (!satisfied) return;
  }
  await wakeTask(task.id, 'manual.start');
}

// GET /api/tasks/[id] - Get a single task.
// Query params:
//   include=workers,artifacts — opt-in expansion. `workers` returns all worker
//     attempts (latest first) with PR refs, summary, error, status, branch,
//     completedAt. `artifacts` returns artifacts attached to those workers,
//     each with a shareUrl. `dispatch` returns the task's dispatch outbox
//     trail (cause, status, transport, handedOffAt, deliveredVia, attempts,
//     lastError), oldest first. `milestones` adds each worker's `milestones` (and returns
//     the workers even without `workers`).
//   include=estimate — the task's frozen estimate (task-estimates experiment),
//     omitted when none was written.
//   Lean by default (spec 3ef37387 R-19, lib/task-read-shape.ts): `context` and
//   `result` reduced to the keys get_task renders, no decision JSON, workspace
//   as id/name/repo. include=context|result|decisions|evidence expands one;
//   include=full is the pre-R-19 row. view=status is a status-only poll.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Dev mode returns mock task data so polling doesn't break
  if (process.env.NODE_ENV === 'development' && (!process.env.DATABASE_URL || !process.env.DEV_USER_EMAIL)) {
    return NextResponse.json({
      id,
      title: 'Development mode task',
      description: null,
      status: 'pending',
      workspaceId: 'dev-workspace',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token may read only its own task; an orchestration task's
  // admin token also the tasks on its own task's mission (checked once the
  // task is read).
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const idError = validateTaskId(id);
  if (idError) return idError;

  try {
    // A task token for a worker-level caller needs to check if the requested
    // task is its own task or a child task, which requires fetching the task.
    // We can't know this without a DB query, so we fetch first then check.
    const shape = taskReadShape(req.nextUrl.searchParams);
    const { include, statusOnly } = shape;
    const columns = taskReadColumns(shape);
    const leanExtras = {
      ...(!statusOnly && !shape.wants('context') ? { leanContext: leanContextSql } : {}),
      ...(!statusOnly && !shape.wants('result') ? { leanResult: leanResultSql } : {}),
    };
    const row = await db.query.tasks.findFirst({
      where: sqlWhere(eq(tasks.id, id)),
      ...(columns ? { columns } : {}),
      ...(Object.keys(leanExtras).length > 0 ? { extras: sqlExtras(leanExtras) } : {}),
      ...(!statusOnly ? { with: {
        workspace: shape.full ? true : { columns: { id: true, name: true, repo: true } },
        mission: { columns: { id: true, title: true, status: true } },
      } } : {}),
    }) as Record<string, any> | undefined;
    // The lean projections answer under the blobs' own names.
    const { leanContext, leanResult, ...task } = row ?? {};

    if (!row) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    if ('leanContext' in row) task.context = leanContext;
    if (apiAccount && !(await taskScopeAllowsMissionTaskRead(apiAccount, task as any))) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Verify access
    if (user && !apiAccount) {
      const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
      if (!access) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    } else if (apiAccount) {
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount, task.workspaceId);
      if (!hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (statusOnly) return NextResponse.json({ id: task.id, workspaceId: task.workspaceId, status: task.status, updatedAt: task.updatedAt });

    let taskWorkers: any[] | undefined;
    let taskArtifacts: any[] | undefined;

    if (include.has('workers') || include.has('artifacts') || include.has('milestones')) {
      taskWorkers = await db.query.workers.findMany({
        where: sqlWhere(eq(workers.taskId, id)),
        orderBy: sqlOrderBy([desc(workers.createdAt), desc(workers.id)]),
        limit: 50,
        columns: {
          id: true,
          status: true,
          branch: true,
          // Which runner a live agent is on ("running on dune" on a chat approval card).
          runner: true,
          prUrl: true,
          prNumber: true,
          error: true,
          currentAction: true,
          // A waiting question renders in chat as a `question` object; already
          // redacted to its type for sensitive workspaces when it's written.
          waitingFor: true,
          startedAt: true,
          completedAt: true,
          lastCommitSha: true,
          commitCount: true,
          filesChanged: true,
          linesAdded: true,
          linesRemoved: true,
          supersededByPrNumber: true,
          abandonedAt: true,
          supersededByPrUrl: true,
          supersededReason: true,
          supersededRecordedBy: true,
          supersededAt: true,
          turns: true,
          inputTokens: true,
          outputTokens: true,
          costUsd: true,
          createdAt: true,
          // The park clock: when a waiting question was asked (questionWaits below).
          updatedAt: true,
          // A gate-rejected completion (outputRequirement 400) persists the
          // agent's summary here instead of discarding it — but until now
          // nothing read it back, so a rejected 60-turn run's only trace was
          // the raw 400 text in `error`. Surfaced read-only: never a
          // satisfied deliverable, just the salvage record of a refused one.
          rejectedCompletionPayload: true,
          // include=milestones: the worker's timeline, including the runner's
          // `Pre-merge:`/`Merge:` lines (what its merge drivers and mergiraf did).
          ...(include.has('milestones') ? { milestones: true as const } : {}),
        },
      });
    }

    if (include.has('artifacts') && taskWorkers && taskWorkers.length > 0) {
      const workerIds = taskWorkers.map(w => w.id);
      const rows = await db.query.artifacts.findMany({
        where: sqlWhere(inArray(artifacts.workerId, workerIds)),
        orderBy: sqlOrderBy([desc(artifacts.updatedAt), desc(artifacts.id)]),
        limit: 50,
        columns: { content: false },
      });
      const baseUrl = appBaseUrl();
      taskArtifacts = rows.map(a => ({
        ...a,
        shareUrl: a.shareToken && a.visibility === 'public' ? `${baseUrl}/share/${a.shareToken}` : null,
      }));
    }

    // result.prUrl / prNumber are derived on read (workflow/task-pr.ts): get_task's PR line reads them.
    const response: Record<string, unknown> = {
      ...task,
      result: withTaskPr(('leanResult' in row ? leanResult : task.result) as Record<string, unknown> | null, await taskPrOf(id)),
      workspace: withoutDispatchToken(task.workspace),
    };
    if (taskWorkers !== undefined) response.workers = taskWorkers;
    // An open question: what waits on its answer, as data (spec 1b257609 R-8).
    // get_task reads workers by default, so it carries this on every waiting task.
    const asking = taskWorkers?.find(w => w.status === 'waiting_input' && w.waitingFor?.type !== 'pause');
    if (asking) {
      const questionWaits = await loadQuestionWaits({
        taskId: id,
        viewer: dependencyViewerOf(user, apiAccount),
        worker: { runner: asking.runner, updatedAt: asking.updatedAt, waitingFor: asking.waitingFor },
      }).catch(() => null);
      if (questionWaits) response.questionWaits = questionWaits;
    }
    if (taskArtifacts !== undefined) response.artifacts = taskArtifacts;
    if (include.has('dispatch')) response.dispatch = await dispatchHistoryForTask(id);
    // Task estimates experiment (packages/core/task-estimate-source.ts): the
    // frozen estimate, when one was written. Absent row => no field.
    if (include.has('estimate')) {
      const estimate = await import('@buildd/core/task-estimate-source')
        .then(m => m.readTaskEstimate(id))
        .catch(() => null);
      if (estimate) {
        const payload = taskEstimatePayload(estimate);
        const display = formatTaskEstimate(payload);
        response.estimate = {
          ...payload,
          // Legacy clients receive the same range; structured consumers ignore prose.
          summary: `${display.headline}. ${display.provenance}`,
          display,
          createdAt: estimate.createdAt,
        };
      }
    }
    const evidenceObjects = shape.wants('evidence') ? await loadInlineEvidence(task.workspaceId, id, {
      surface: 'get_task',
      // The account decides access above when both are present, so it is the actor.
      actor: apiAccount ? { accountId: apiAccount.id } : { userId: user!.id },
    }) : [];
    if (evidenceObjects.length > 0) response.evidenceObjects = evidenceObjects;

    return NextResponse.json(response);
  } catch (error) {
    console.error('Get task error:', error);
    return NextResponse.json({ error: 'Failed to get task' }, { status: 500 });
  }
}

// PATCH /api/tasks/[id] - Update a task
/**
 * What a per-task token may change on its own task: what the task says, not
 * how it runs or ends. Status, mission, dependencies, role, model, hold and
 * result go through complete_task and the gates behind it, or through a person.
 */
const TASK_TOKEN_PATCH_FIELDS = new Set(['title', 'description', 'priority', 'project', 'externalIssueId', 'externalIssueUrl', 'waitOn']);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Read-your-writes (spec 3ef37387 R-20): the change version moves before this answers.
  // The body is deliberately not re-indented, so this stays a small diff.
  try {
  const { id } = await params;

  // Dev mode returns mock
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ id, title: 'Updated Task' });
  }

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token may edit only its own task, and only its descriptive
  // fields (TASK_TOKEN_PATCH_FIELDS).
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const patchIdError = validateTaskId(id);
  if (patchIdError) return patchIdError;

  try {
    const task = await db.query.tasks.findFirst({
      where: sqlWhere(eq(tasks.id, id)),
      with: { workspace: true },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    // A task token can only edit its own task, not child tasks
    if (apiAccount && !taskScopeAllowsTask(apiAccount, id)) {
      // GET lets a task token read any task in its own workspace, so a 404
      // here contradicts what the caller just saw. Say it is a scope limit
      // when the task is visible to it; stay 404 for a task it cannot see.
      if (apiAccount.taskScope && task.workspaceId === apiAccount.taskScope.workspaceId) {
        return NextResponse.json({
          error: 'A task token may only edit its own task. This task is in your workspace but is not yours to change; ask a person or an organizer to cancel or edit it.',
        }, { status: 403 });
      }
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Verify access
    if (user && !apiAccount) {
      const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
      if (!access) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    } else if (apiAccount) {
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount, task.workspaceId);
      if (!hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const body = await req.json();
    if (apiAccount?.taskScope && body && typeof body === 'object') {
      const refused = Object.keys(body).filter(k => !TASK_TOKEN_PATCH_FIELDS.has(k));
      if (refused.length > 0) {
        return NextResponse.json({
          error: `A task token may not change ${refused.join(', ')} on its task. Finish with complete_task; ask a person or an organizer for anything else.`,
        }, { status: 403 });
      }
    }
    const { title, description, priority, project, missionId, dependsOn, status, roleSlug, requiredConnectors: rawRequiredConnectors, externalIssueId, externalIssueUrl, backend, tier, model, maxLoops, actorWorkerId, resultSummary, correctedBy, held, heldReason, reserved, pathManifest, startAt, startIn, abort, cancelReason, supersededBy } = body;

    // delegation: a person grants (or clears) this task's cross-workspace
    // reach before it is claimed (lib/task-delegation.ts). Its own request:
    // the claim pre-flight reads it, and a running token re-reads it on every
    // call, but a grant is decided before the run, not mid-edit of something else.
    if (body && typeof body === 'object' && 'delegation' in body) {
      if (Object.keys(body).some(k => k !== 'delegation')) {
        return NextResponse.json({ error: 'delegation is sent on its own, with no other fields' }, { status: 400 });
      }
      if (task.status !== 'pending') {
        return NextResponse.json({
          error: `A task's delegation is set before it is claimed; this one is ${task.status}. A running agent asks with request_capability instead.`,
          code: 'not_pending',
        }, { status: 409 });
      }
      const write = await resolveTaskDelegationWrite(body.delegation, task.workspaceId, requestingPerson(user, apiAccount));
      if (!write.ok) return NextResponse.json({ error: write.error }, { status: write.status });
      const [updated] = await db.update(tasks)
        .set({ delegation: write.value, updatedAt: new Date() })
        .where(and(eq(tasks.id, id), eq(tasks.status, 'pending')))
        .returning({ id: tasks.id, delegation: tasks.delegation });
      if (!updated) {
        return NextResponse.json({ error: 'The task was claimed while the delegation was being set; a running agent asks with request_capability instead.', code: 'not_pending' }, { status: 409 });
      }
      // A token minted for this task reads its delegation through the caller cache.
      await clearCallerCache(callerDep.task(id));
      return NextResponse.json({ id: updated.id, delegation: updated.delegation });
    }

    // waitOn: the agent working this task found another task holds it, so the
    // run ends waiting on that task instead of failing (lib/task-wait-exit.ts,
    // Living Spec d25d923d R-20). Its own request, like pause.
    if (body?.waitOn !== undefined) {
      if (Object.keys(body).some(k => k !== 'waitOn')) {
        return NextResponse.json({ error: 'waitOn is sent on its own, with no other fields' }, { status: 400 });
      }
      const parsed = parseWaitOn(body.waitOn);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: parsed.status });
      const workerId = typeof body.waitOn.workerId === 'string' ? body.waitOn.workerId : null;
      const out = await applyWaitExit({
        task: { ...task, dependsOn: (task.dependsOn as string[] | null) ?? null, gitConfig: task.workspace?.gitConfig ?? null },
        blockerTaskId: parsed.blockerTaskId,
        reason: parsed.reason,
        workerId,
      });
      if (!out.ok) return NextResponse.json({ error: out.error, code: out.code }, { status: out.status });
      noteWorkChanged({ missionIds: [task.missionId] });
      await emitTaskUpdated({ id, workspaceId: task.workspaceId, missionId: task.missionId ?? null, status: 'pending' });
      return NextResponse.json({ id, status: 'pending', waitingOn: out.blocker, dependsOn: out.dependsOn, workerId: out.workerId });
    }

    // pause: true pauses the agent working on this task instead of cancelling
    // it (lib/worker-pause.ts): the session is kept and Resume continues it.
    // It is its own request, never mixed with other edits.
    if (body?.pause !== undefined) {
      if (body.pause !== true) return NextResponse.json({ error: 'pause must be true' }, { status: 400 });
      if (Object.keys(body).some(k => k !== 'pause')) {
        return NextResponse.json({ error: 'pause is sent on its own, with no other fields' }, { status: 400 });
      }
      const liveWorker = await db.query.workers.findFirst({
        where: sqlWhere(and(eq(workers.taskId, id), inArray(workers.status, [...LIVE_WORKER_STATUSES]))),
        columns: { id: true, status: true, runner: true, waitingFor: true },
      });
      if (!liveWorker) {
        return NextResponse.json({ error: 'No agent is working on this task, so there is nothing to pause.', code: 'not_running' }, { status: 409 });
      }
      const refusal = pauseRefusal(liveWorker);
      if (refusal) return NextResponse.json({ error: refusal.error, code: refusal.code, workerId: liveWorker.id }, { status: refusal.status });
      if (!(await requestWorkerPause(liveWorker.id))) {
        return NextResponse.json({ error: 'The agent stopped running before the pause landed.', code: 'not_running', workerId: liveWorker.id }, { status: 409 });
      }
      return NextResponse.json({ id, paused: 'requested', workerId: liveWorker.id });
    }

    // pathManifest is set at creation (POST /api/tasks) and only ever grows from
    // there, via check_path_claim / POST /api/tasks/[id]/path-claim, which take a
    // real path_claims lock for each added path. There is no matching "release"
    // path for dropping entries, so a PATCH here would silently desync the
    // declarative manifest from any held claims — reject rather than accept and
    // do nothing (see friction task 2a201508).
    if (pathManifest !== undefined) {
      return NextResponse.json(
        { error: 'pathManifest is immutable after creation via PATCH — use check_path_claim (MCP) or POST /api/tasks/[id]/path-claim to add paths to it.' },
        { status: 400 },
      );
    }

    const updateData: Partial<typeof tasks.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (priority !== undefined) updateData.priority = priority;
    // Agent backend override for this task. 'claude' | 'codex' set it; null/'' clears
    // it (fall back to mission/role/workspace default). The runner reads it at claim.
    if (backend !== undefined) {
      const nextBackend = backend === 'claude' || backend === 'codex' ? backend : null;
      updateData.backend = nextBackend;

      // A budget/rate-limit pause parks the task behind a start_at floor set to
      // the WALLED provider's reset. Moving the task to another provider has to
      // lift that floor too, or the switch appears to do nothing until the old
      // provider resets — the "can't switch to Claude" trap.
      const taskCtx = (task.context || {}) as Record<string, unknown>;
      const currentBackend = task.backend || 'claude';
      if (taskCtx.budgetExhausted && (nextBackend || 'claude') !== currentBackend) {
        const { budgetExhausted: _paused, budgetResetsAt: _resets, ...restCtx } = taskCtx;
        updateData.startAt = null;
        updateData.context = { ...restCtx, switchedBackendFrom: currentBackend };
      }

      // An operator naming a different backend has chosen it, so budget failover
      // must not move it back (BACKEND_PINNED_KEY); clearing to the default
      // drops the pin. Re-sending the current backend leaves context untouched.
      const baseCtx = (updateData.context ?? taskCtx) as Record<string, unknown>;
      if (nextBackend && nextBackend !== currentBackend) {
        updateData.context = { ...baseCtx, [BACKEND_PINNED_KEY]: true };
      } else if (!nextBackend && baseCtx[BACKEND_PINNED_KEY] !== undefined) {
        const { [BACKEND_PINNED_KEY]: _pin, ...unpinned } = baseCtx;
        updateData.context = unpinned;
      }
    }
    // Model pin for the NEXT claim or retry (never the in-flight session).
    // `tier` is the tier-first override (tasks.tier); `model` is a concrete id
    // pinned in context.model with the context.modelPinned marker the claim
    // route reads via readModelPin. null clears either so routing decides again.
    // A tier set without a model drops any existing model pin — otherwise the
    // pin would silently outrank the tier the caller just asked for.
    if (tier !== undefined || model !== undefined) {
      if (tier !== undefined && tier !== null && !isTaskTier(tier)) {
        return NextResponse.json(
          { error: `tier must be one of: ${TIERS.join(', ')} (or null to clear)` },
          { status: 400 },
        );
      }
      if (model !== undefined && model !== null && !isAcceptableModelPin(model)) {
        return NextResponse.json(
          { error: 'model must be an Anthropic model id (e.g. claude-…) or null to clear' },
          { status: 400 },
        );
      }
      // Model-tier ceiling: a re-tier or re-pin above the effective maximum is
      // refused here; lowering is always allowed. The claim re-checks anyway.
      const ceilingRejection = await rejectOverCeiling({
        subject: { teamId: task.workspace?.teamId, workspaceId: task.workspaceId, userId: lazyRequester(task) },
        surface: 'agent',
        request: { tier, model },
        gate: { surface: 'PATCH /api/tasks/[id]', workspaceId: task.workspaceId, taskId: task.id },
      });
      if (ceilingRejection) return ceilingRejection;
      if (tier !== undefined) updateData.tier = tier;

      const baseCtx = (updateData.context ?? task.context ?? {}) as Record<string, unknown>;
      if (model !== undefined && model !== null) {
        updateData.context = { ...baseCtx, model: (model as string).trim(), modelPinned: true };
      } else if (model === null || (tier && readModelPin(baseCtx) !== null)) {
        const { model: _dropped, ...rest } = baseCtx;
        updateData.context = { ...rest, modelPinned: false };
      }
    }
    if (project !== undefined) updateData.project = project;
    // Link (or unlink) the task to an external issue tracker item (e.g. a Linear
    // issue). Setting this is what enables the PR-merge completion comment in the
    // GitHub webhook (maybePostWorkTrackerIssueUpdate reads task.externalIssueId).
    if (externalIssueId !== undefined) updateData.externalIssueId = externalIssueId || null;
    if (externalIssueUrl !== undefined) updateData.externalIssueUrl = externalIssueUrl || null;
    if (missionId !== undefined) {
      // A mission link must stay inside the task's team (see isMissionLinkable).
      if (missionId && !(await isMissionLinkable(missionId, task.workspace?.teamId))) {
        return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
      }
      updateData.missionId = missionId || null;
    }
    if (roleSlug !== undefined) {
      // Same gate as creation (POST /api/tasks): an edit may not move a task
      // onto another member's private role. Who the task is for is read with
      // any (already scope-checked) mission change in this same PATCH applied.
      const nextRoleSlug = typeof roleSlug === 'string' && roleSlug ? roleSlug : null;
      if (nextRoleSlug && nextRoleSlug !== task.roleSlug) {
        const statedRole = await checkStatedRole(nextRoleSlug, {
          teamId: task.workspace?.teamId ?? null,
          workspaceId: task.workspaceId,
          requesterUserId: lazyRequester(
            missionId !== undefined ? { ...task, missionId: missionId || null } : task,
          ),
        });
        if (statedRole.refused) {
          return NextResponse.json(statedRole.refused, { status: 400 });
        }
      }
      updateData.roleSlug = roleSlug || null;
    }
    if (dependsOn !== undefined) {
      if (!Array.isArray(dependsOn) || !dependsOn.every((id: unknown) => typeof id === 'string')) {
        return NextResponse.json({ error: 'dependsOn must be an array of task IDs' }, { status: 400 });
      }
      // Same rule as POST /api/tasks (spec e28018c2): a dependency is a task
      // of this task's team the caller sees, and never the task itself. Only
      // the ids being added are checked (R-4): one already on the task is kept
      // as is, so a caller who cannot see it can still edit or remove it.
      if (dependsOn.includes(task.id)) {
        return NextResponse.json({ error: 'A task cannot depend on itself' }, { status: 400 });
      }
      const existingDeps = new Set((task.dependsOn as string[] | null) ?? []);
      const added = [...new Set(dependsOn as string[])].filter(d => !existingDeps.has(d));
      if (added.length > 0) {
        const teamId = task.workspace?.teamId ?? null;
        const viewer = dependencyViewerOf(user, apiAccount);
        const reach = await checkDependencyReach({ viewer, teamId, ids: added });
        if (!reach.ok) return NextResponse.json({ error: reach.error }, { status: 400 });
        // R-16: only a new edge can close a cycle; the walk follows the team's edges.
        const cycle = await checkDependencyCycle({ viewer, teamId, taskId: task.id, dependsOn: added });
        if (!cycle.ok) return NextResponse.json({ error: cycle.error }, { status: 400 });
      }
      updateData.dependsOn = dependsOn;
    }
    // Hold / resume one task (the claim route's taskNotHeld gate reads
    // context.heldBy). A running worker keeps its session; the caller tells it
    // to stop at a safe point (chat does, through /instruct).
    if (held !== undefined) {
      if (typeof held !== 'boolean') {
        return NextResponse.json({ error: 'held must be true or false' }, { status: 400 });
      }
      if (held && isTerminalTaskStatus(task.status)) {
        return NextResponse.json({ error: `A ${task.status} task can't be held` }, { status: 400 });
      }
      const baseCtx = { ...((updateData.context ?? task.context ?? {}) as Record<string, unknown>) };
      if (held) {
        baseCtx.heldBy = {
          at: new Date().toISOString(),
          userId: user && !apiAccount ? user.id : null,
          ...(typeof heldReason === 'string' && heldReason.trim() ? { reason: heldReason.trim().slice(0, 280) } : {}),
        };
      } else {
        delete baseCtx.heldBy;
      }
      updateData.context = baseCtx;
    }
    // Reserve / release a waiting task for the calling interactive session
    // (the claim route's taskNotReserved gate reads context.reservedBy). Runners
    // and other accounts skip it until it lapses; re-sending reserved: true
    // renews it. Only an account identity can hold one, the same identity
    // claim_task authenticates as, so a dashboard user is refused.
    if (reserved !== undefined) {
      if (typeof reserved !== 'boolean') {
        return NextResponse.json({ error: 'reserved must be true or false' }, { status: 400 });
      }
      // Only a verified interactive session may hold a reservation: it is what the
      // claim route lets the reserver's own claim_task through for. A caller that
      // is not one would park the task from every claimer, itself included.
      if (!apiAccount || !verifyInteractiveSession(req.headers.get(INTERACTIVE_SESSION_HEADER), apiAccount.id)) {
        return NextResponse.json({ error: 'A reservation belongs to the interactive session that claim_task would run as; call this from that session.' }, { status: 403 });
      }
      if (task.status !== 'pending' || task.claimedBy) {
        return NextResponse.json({ error: `This task is already ${task.status === 'pending' ? 'claimed by a worker' : task.status}; only a waiting task can be reserved.` }, { status: 409 });
      }
      const baseCtx = { ...((updateData.context ?? task.context ?? {}) as Record<string, unknown>) };
      const current = baseCtx[TASK_RESERVATION_KEY] as { accountId?: string; expiresAt?: string } | undefined;
      const liveOther = !!current && current.accountId !== apiAccount.id
        && !!current.expiresAt && new Date(current.expiresAt).getTime() > Date.now();
      if (liveOther) {
        return NextResponse.json({ error: 'Another session holds this reservation. It lapses on its own if that session goes quiet.' }, { status: 409 });
      }
      if (reserved) {
        baseCtx[TASK_RESERVATION_KEY] = buildReservation(apiAccount.id);
      } else {
        delete baseCtx[TASK_RESERVATION_KEY];
      }
      updateData.context = baseCtx;
    }
    // Reschedule: move a queued task's start later, or back to ASAP (startAt:
    // null), without cancelling it. The claim route already honours startAt
    // and the outbox trigger re-wakes on the new time. Only before a worker
    // has the task: a started run is paused or cancelled, not rescheduled.
    if (startAt !== undefined || startIn !== undefined) {
      if (task.status !== 'pending' || task.claimedBy) {
        const state = task.status === 'pending' ? 'claimed by a worker' : task.status;
        return NextResponse.json(
          { error: `This task is already ${state}, so it has no start time to move. A start time only applies while a task is waiting; cancel it, or wait for it to finish.` },
          { status: 409 },
        );
      }
      let deferred;
      try {
        deferred = startAt === null && startIn === undefined
          ? { startAt: null, resolution: null }
          : resolveDeferredStart({ startAt, startIn });
      } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid start time' }, { status: 400 });
      }
      updateData.startAt = deferred.startAt;
      const baseCtx = { ...((updateData.context ?? task.context ?? {}) as Record<string, unknown>) };
      if (deferred.resolution) {
        baseCtx.startResolution = deferred.resolution;
        baseCtx.rescheduledBy = { at: new Date().toISOString(), userId: user && !apiAccount ? user.id : null };
      } else {
        delete baseCtx.startResolution;
        delete baseCtx.rescheduledBy;
      }
      updateData.context = baseCtx;
    }
    if (rawRequiredConnectors !== undefined) {
      if (rawRequiredConnectors === null) {
        updateData.requiredConnectors = null;
      } else {
        // roleSlug may be changing in this same PATCH; validate against the value
        // the task will actually have.
        const check = await validateRequiredConnectors(rawRequiredConnectors, {
          roleSlug: roleSlug !== undefined ? (roleSlug || null) : task.roleSlug,
          workspaceId: task.workspaceId,
          teamId: (task as any).workspace?.teamId ?? null,
          // Who the task is for decides which personal role's refs count.
          requesterUserId: await lazyRequester(task)(),
        });
        if (!check.ok) {
          return NextResponse.json({ error: check.error }, { status: 400 });
        }
        updateData.requiredConnectors = check.value;
      }
    }
    if (maxLoops !== undefined) {
      if (!task.loopConfig) {
        return NextResponse.json(
          { error: 'maxLoops can only be adjusted on an existing looped task' },
          { status: 400 },
        );
      }
      let normalized;
      try {
        normalized = parseLoopConfig({ ...task.loopConfig, maxLoops });
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : 'Invalid maxLoops' },
          { status: 400 },
        );
      }
      if (normalized && normalized.maxLoops! < task.loopIteration) {
        return NextResponse.json(
          { error: `maxLoops cannot be lower than the ${task.loopIteration} completed loop iterations` },
          { status: 400 },
        );
      }
      updateData.loopConfig = normalized;
    }

    // Correct a completed/failed task's stored result.summary after the fact (e.g. a
    // stray assistant aside got captured, or a runner/server bug garbled it). The
    // completion PATCH in /api/workers/[id] refuses to write result once a task is
    // terminal, so this is the only path to amend the durable record. The MCP tool
    // (correct_task_result) already gates on admin token level before calling this
    // route, but the route is reachable directly, so it re-checks here too — an
    // ordinary workspace API key (bld_xxx, level 'worker'/'trigger') must not be able
    // to rewrite a completed task's audit trail just because it has workspace access.
    if (resultSummary !== undefined) {
      if (apiAccount && !hasTokenRouteAdminAccess(apiAccount, req, 'tasks:admin')) {
        return NextResponse.json({ error: 'Correcting a task result requires tasks:admin scope or an admin-level legacy token' }, { status: 403 });
      }
      if (typeof resultSummary !== 'string' || resultSummary.trim() === '') {
        return NextResponse.json({ error: 'resultSummary must be a non-empty string' }, { status: 400 });
      }
      if (!isTerminalTaskStatus(task.status)) {
        return NextResponse.json(
          { error: `Cannot correct result.summary on a '${task.status}' task — only a finished (completed, failed or cancelled) task has a stored result to correct.` },
          { status: 400 },
        );
      }
      const existingResult = (task.result || {}) as Record<string, unknown>;
      updateData.result = {
        ...existingResult,
        summary: resultSummary,
        previousSummary: existingResult.summary as string | undefined,
        summaryCorrectedAt: new Date().toISOString(),
        correctedBy: correctedBy || undefined,
      };
    }

    if (status !== undefined) {
      const allowedStatuses = ['pending', 'completed', 'failed', 'cancelled'];
      if (!allowedStatuses.includes(status)) {
        return NextResponse.json(
          { error: `Invalid status. Allowed: ${allowedStatuses.join(', ')}` },
          { status: 400 }
        );
      }
      // Only block completed/failed on active workers — cancelled bypasses this so owners
      // can kill duplicate or stuck tasks regardless of worker state.
      if (status === 'completed' || status === 'failed') {
        const activeWorker = await db.query.workers.findFirst({
          where: sqlWhere(and(
            eq(workers.taskId, id),
            inArray(workers.status, ['running', 'waiting_input']),
          )),
        });
        if (activeWorker) {
          return NextResponse.json(
            { error: 'Cannot change status directly — task has an active worker. Use complete_task via the worker instead.' },
            { status: 409 }
          );
        }
      }
      // Cancelling stops a live agent mid-run: its session ends and any work it
      // has not pushed is lost. The caller has to ask for that (abort: true);
      // without it the cancel is refused and nothing changes.
      if (status === 'cancelled') {
        if (abort !== undefined && typeof abort !== 'boolean') {
          return NextResponse.json({ error: 'abort must be true or false' }, { status: 400 });
        }
        if (abort !== true) {
          const liveWorker = await db.query.workers.findFirst({
            where: sqlWhere(and(eq(workers.taskId, id), inArray(workers.status, [...LIVE_WORKER_STATUSES]))),
            columns: { id: true, status: true },
          });
          if (liveWorker) {
            return NextResponse.json(
              {
                error: `An agent is working on this task right now (worker ${liveWorker.id}, ${liveWorker.status}). Cancelling stops it mid-run and loses anything it has not pushed. To keep its work, pause it instead (pause: true). To stop it anyway, send abort: true. To hold work that has not started, move its start time instead.`,
                code: 'live_worker',
                workerId: liveWorker.id,
              },
              { status: 409 },
            );
          }
        }
      }
      // A cancel says why (failure-incident-recovery §18.5): an API caller
      // must pass cancelReason or supersededBy; a dashboard cancel is the
      // person's own act. Refused before anything is written.
      if (status === 'cancelled') {
        const parsed = parseCancellation({
          cancelReason,
          supersededBy,
          actor: apiAccount ? `account:${apiAccount.id}` : `user:${user?.id ?? 'unknown'}`,
          byPerson: !apiAccount,
        });
        if (!parsed.ok) return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: 400 });
        updateData.context = { ...((updateData.context ?? task.context ?? {}) as Record<string, unknown>), cancellation: parsed.cancellation };
      }
      updateData.status = status;

      // When resetting to pending, clear claim fields so the task is claimable again
      if (status === 'pending') {
        // The owner's requeue also ends the task's live workers (their runner
        // may be gone); otherwise they stay running and the task never leaves
        // RUNNING until the stale-worker reap.
        await endLiveWorkersForRequeue(id);
        updateData.claimedBy = null;
        updateData.claimedAt = null;
        updateData.expiresAt = null;
      }
    }

    const [updated] = await db
      .update(tasks)
      .set(updateData)
      .where(eq(tasks.id, id))
      .returning();

    // Its mission's stored summary, and the one it left (lib/work-changed.ts).
    if (updated) noteWorkChanged({ missionIds: [updated.missionId, task.missionId] });

    // Status-change side effects. A PATCH that doesn't touch status (title,
    // priority, …) runs none of this.
    if (status !== undefined && updated) {
      const ref = { id, workspaceId: updated.workspaceId, missionId: updated.missionId ?? null };
      if (status === 'cancelled') {
        // Abort the active worker, release path claims, resolve (parent/mission
        // dormancy) and emit TASK_UPDATED — shared with the GitHub issue-close
        // webhook and bulk cancel so every cancel path behaves the same.
        await applyTaskCancelSideEffects(ref);
      } else {
        await emitTaskUpdated({ ...ref, status });
        if (status === 'completed' || status === 'failed') {
          // Manual complete/fail must unblock or cascade dependents exactly like a
          // worker completion does. Exception: a human failing a *planning* task
          // skips resolveCompletedTask, because its failed-planning branch treats
          // the failure as infrastructure and auto-retriggers the mission — which
          // would undo the deliberate stop. Retrigger such a mission manually.
          const skipPlanningRetrigger = status === 'failed' && task.mode === 'planning';
          if (!skipPlanningRetrigger) {
            await resolveCompletedTask(id, updated.workspaceId).catch((err) =>
              console.error('[task-patch] resolveCompletedTask failed:', err)
            );
          }
        } else if (status === 'pending') {
          await wakeIfDependenciesSatisfied(updated).catch((err) =>
            console.error('[task-patch] pending wake failed:', err)
          );
        }
      }
    }

    // When a task transitions to a non-terminal status (un-cancel, re-open, or new
    // missionId link), reopen the mission if it's currently completed. Idempotent.
    const isNowOpen = status !== undefined && !isTerminalTaskStatus(status as string);
    const missionLinkAdded = missionId !== undefined && updated?.missionId && updated.missionId !== task.missionId;
    const missionUnlinked = missionId !== undefined && !updated?.missionId && task.missionId;

    // A task that left its mission (unlinked, or moved to another): modules
    // holding per-mission state about it let go (the surface audit drops its
    // edge; lib/surface-audit-subscribers.ts). emit never throws.
    if (missionId !== undefined && task.missionId && updated && updated.missionId !== task.missionId) {
      await emit({ type: 'task.left_mission', taskId: id, missionId: task.missionId, workspaceId: updated.workspaceId ?? null });
    }
    // A task linked to a mission gets the scope decision a task filed into it does
    // (lib/mission-subscribers.ts, docs/specs/workflow-kernel-library.md §6).
    if (missionLinkAdded && updated?.missionId) {
      await emit({ type: 'task.joined_mission', taskId: id, missionId: updated.missionId, workspaceId: updated.workspaceId });
    }
    // Resuming a task its mission's scope decision held is the person's answer "it fits the
    // mission as written" (the question note says so): recorded once, the note answered.
    if (held === false && task.missionId && updated?.missionId === task.missionId
      && isOwnScopeHold((task.context as Record<string, unknown> | null)?.heldBy, task.missionId)) {
      const person = requestingPerson(user, apiAccount);
      const { MISSION_SCOPE_ANSWER } = await import('@/modules');
      await MISSION_SCOPE_ANSWER.answerQuietly({
        taskId: id, workspaceId: updated.workspaceId, missionId: task.missionId, answer: 'in_scope',
        actor: person ? `human:${person}` : `agent:${apiAccount?.id ?? 'unknown'}`,
        principal: kernelPrincipalOf({ person, account: apiAccount }),
      });
    }

    // A task linked/unlinked/created against a mission is exactly the kind of
    // silent work the mission feed used to miss — attribute it whether it came
    // from the dashboard, a plain API call, or an external MCP caller. Lazily
    // imported so route modules that never touch a mission-linked task don't
    // pull in mission-feed's db/schema deps.
    if (missionLinkAdded || missionUnlinked || (updated?.missionId && isNowOpen)) {
      import('@/lib/mission-feed').then(async (feedMod) => {
        const feedActor = await feedMod.resolveFeedActor({ user, apiAccount, actorWorkerId });
        if (missionLinkAdded || missionUnlinked) {
          const targetMissionId = missionLinkAdded ? updated!.missionId! : task.missionId!;
          await feedMod.postMissionFeedEvent({
            missionId: targetMissionId,
            type: 'update',
            title: missionLinkAdded ? `Task linked: ${updated!.title}` : `Task unlinked: ${task.title}`,
            body: `Task ${id}`,
            actor: feedActor,
            taskId: id,
          });
        }
        if (updated?.missionId && (isNowOpen || missionLinkAdded)) {
          const { reopenCompletedMission } = await import('@/lib/mission-loop');
          await reopenCompletedMission(updated.missionId, feedActor);
        }
      }).catch((err) => console.error('[task-patch] mission-feed/reopen failed:', err));
    }

    // Replacing a role a role pick applied is an implicit correction of that
    // decision. Clearing it is not (there is no corrected answer), and a role
    // the task never had cannot have been picked. The decisions module labels
    // it (lib/decision-subscribers.ts); emit never throws.
    const nextRoleSlug = updated?.roleSlug ?? null;
    const teamId = task.workspace?.teamId;
    if (roleSlug !== undefined && teamId && task.roleSlug && nextRoleSlug && nextRoleSlug !== task.roleSlug) {
      await emit({
        type: 'task.role_changed',
        taskId: id,
        teamId,
        from: task.roleSlug,
        to: nextRoleSlug,
        by: apiAccount?.id ?? user?.id ?? null,
      });
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error('Update task error:', error);
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
  } finally { await settleWorkChanges(); }
}

// DELETE /api/tasks/[id] - Delete a task (only pending tasks)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Read-your-writes (spec 3ef37387 R-20): the change version moves before this answers.
  // The body is deliberately not re-indented, so this stays a small diff.
  try {
  const { id } = await params;

  // Dev mode returns success
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ success: true });
  }

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const deleteIdError = validateTaskId(id);
  if (deleteIdError) return deleteIdError;

  try {
    const task = await db.query.tasks.findFirst({
      where: sqlWhere(eq(tasks.id, id)),
      with: { workspace: true },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Verify access
    if (user && !apiAccount) {
      const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
      if (!access) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    } else if (apiAccount) {
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount, task.workspaceId);
      if (!hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // ?force=true skips status check (for test cleanup scripts)
    const force = req.nextUrl.searchParams.get('force') === 'true';

    if (!force) {
      // Anything but a running task — the same rule the delete button shows by.
      if (!canDeleteTask(task.status)) {
        return NextResponse.json(
          { error: `Cannot delete ${task.status} tasks. Wait for completion or use reassign.` },
          { status: 400 }
        );
      }
    }

    // Settle and abort its live workers and release its claims first: the
    // delete orphans the worker rows (task_id → NULL), and a question parked
    // on one would otherwise stay live, holding a slot, with no task to end it.
    await applyTaskDeleteSideEffects(id);
    // The row is gone after the delete, so resolve the scopes it versions on first.
    const deletedScopes = await scopesOfDeletedTasks([id]);
    await db.delete(tasks).where(eq(tasks.id, id));
    await bumpChangeVersions(deletedScopes);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete task error:', error);
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 });
  }
  } finally { await settleWorkChanges(); }
}
