import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers, missions } from '@buildd/core/db/schema';
import { eq, and, isNull, isNotNull, inArray, ne } from 'drizzle-orm';
import { wakeTask } from '@/lib/dispatch-authority';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { checkConnectorRouting, findAlternativeRole, type ConnectorFailure } from '../../../workers/claim/connector-gate';
import { checkMissionHeld, checkMissionLocal } from '../../../workers/claim/held-gate';
import { checkMissionBudgetExhausted } from '../../../workers/claim/mission-budget-gate';
import { checkWorkspaceCap } from '../../../workers/claim/workspace-cap-gate';
import { BYPASS_SUBJECT_GATE_KEY, isSubjectDead } from '@/lib/subject-gate-contract';
import { BYPASS_HELD_GATE_KEY, BYPASS_MISSION_BUDGET_KEY, CAP_EXEMPT_KEY, hasBypassFlag } from '@/lib/bypass-flags';
import { ENTITLEMENT_BLOCK_CONTEXT_KEY } from '@buildd/shared';
import { checkManagedRunnerEntitlement } from '@/lib/entitlements/managed-runner';
import { probeCoordination } from '@/lib/coordination-probe';
import { buildForceStartIntent, recordForceStartRequest } from '@/lib/force-start';
import {
  FORCE_START_CONTEXT_KEY,
  RAIL_TEXT,
  blockingReasons,
  canForceStart,
  gateName,
  railsRemainingFor,
  waitingHeadline,
  waitingReasonsDigest,
  type ForceStartIntent,
  type WaitingReason,
} from '@buildd/core/waiting-reason';

/**
 * POST /api/tasks/[id]/start
 *
 * Start a pending task by notifying workers to claim it.
 * Supports dual auth: API key (Bearer) or session cookie.
 * - Wakes it through the dispatch authority (cause `manual.start`)
 * - Optionally targets a specific runner instance
 *
 * Body:
 * - targetLocalUiUrl?: string - Specific runner to assign to (optional)
 * - forceOverride?: boolean - lift the policy gates above (startAt, deps, holds, budget, subject)
 * - capExempt?: boolean - run past the workspace cap this once
 * - forceCoordination?: { reasonsDigest, note? } - Force start past the coordination
 *   gates a 422 `coordination_hold` named. The digest must be the one that refusal
 *   returned: a person never confirms a gate they did not see (409 otherwise).
 *   Persisted as `context.forceStart` and honoured by the next runner's claim —
 *   never a claim made here (see lib/force-start.ts).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Dual auth: API key or session
  let authType: 'api' | 'session';
  let accountId: string | null = null;
  let userId: string | null = null;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await authenticateApiKey(apiKey, req);
    if (!account) {
      return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    }
    authType = 'api';
    accountId = account.id;
  } else {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    authType = 'session';
    userId = user.id;
  }

  const { id: taskId } = await params;

  try {
    const body = await req.json().catch(() => ({}));
    const { targetLocalUiUrl, forceOverride, capExempt } = body;
    const forceCoordination = body.forceCoordination && typeof body.forceCoordination === 'object'
      ? body.forceCoordination as { reasonsDigest?: unknown; note?: unknown }
      : null;

    // Get the task
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      with: { workspace: true },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Authorization check
    if (authType === 'session') {
      const access = await verifyWorkspaceAccess(userId!, task.workspaceId);
      if (!access) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
    } else {
      const hasAccess = await verifyAccountWorkspaceAccess(accountId!, task.workspaceId);
      if (!hasAccess) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
    }

    // Only allow starting pending tasks
    if (task.status !== 'pending') {
      return NextResponse.json({
        error: `Cannot start task with status: ${task.status}. Only pending tasks can be started.`,
        status: task.status,
      }, { status: 400 });
    }

    if (task.startAt && task.startAt > new Date() && !forceOverride) {
      return NextResponse.json({
        error: `Task is deferred until ${task.startAt.toISOString()}`,
        gateReason: 'deferred_start',
        blockClass: 'policy',
        startAt: task.startAt.toISOString(),
        canForce: true,
      }, { status: 422 });
    }

    // Check the claim-route dep gate: if any dependency is completed but has an unmerged PR,
    // the claim route will silently skip this task. Surface that here before broadcasting.
    const dependsOn = (task.dependsOn as string[] | null) || [];
    if (dependsOn.length > 0 && !forceOverride) {
      const openDepWorkers = await db.query.workers.findMany({
        where: and(
          inArray(workers.taskId, dependsOn),
          isNotNull(workers.prUrl),
          isNull(workers.mergedAt),
        ),
        with: {
          task: { columns: { id: true, title: true, status: true } },
        },
        columns: { id: true, prUrl: true, prNumber: true, taskId: true },
      });

      // Only gate on dep tasks that are completed — tasks that aren't completed
      // block for a different reason (status check) and are already shown by the
      // "blocked" banner in the UI.
      const gated = openDepWorkers.filter(w => w.task?.status === 'completed');

      if (gated.length > 0) {
        return NextResponse.json({
          error: 'Task is blocked: dependency PR(s) not yet merged',
          gateReason: 'unmerged_dep_pr',
          blockClass: 'policy',
          blockingDeps: gated.map(w => ({
            taskId: w.taskId,
            taskTitle: w.task?.title || null,
            prUrl: w.prUrl,
            prNumber: w.prNumber,
          })),
          canForce: true,
        }, { status: 422 });
      }
    }

    // ── Connector routing gate ──────────────────────────────────────────────
    // If the task's role requires connectors not visible in this workspace,
    // no worker can ever claim it — surface the reason before broadcasting.
    const roleSlug = (task as any).roleSlug as string | null;
    const teamId = (task.workspace as any)?.teamId as string | null;
    if (roleSlug && teamId) {
      const connectorFailures = await checkConnectorRouting(roleSlug, task.workspaceId, teamId);
      if (connectorFailures) {
        const detail = connectorFailures
          .map(f => `'${f.connectorName}' (${f.mode})`)
          .join(', ');
        const alternativeRole = await findAlternativeRole(roleSlug, task.workspaceId, teamId);
        return NextResponse.json({
          error: `Task cannot be started: role '${roleSlug}' has connector issues: ${detail}`,
          gateReason: 'connector_routing_mismatch',
          blockClass: 'capability',
          connectorFailures: connectorFailures.map((f: ConnectorFailure) => ({
            connectorId: f.connectorId,
            connectorName: f.connectorName,
            mode: f.mode,
          })),
          ...(alternativeRole ? { alternativeRole } : {}),
        }, { status: 422 });
      }
    }

    // ── Mission held gate ───────────────────────────────────────────────────
    // Held missions block all task claims until armed. forceOverride bypasses
    // this gate (the bypassHeldGate context key is written below).
    const missionId = (task as any).missionId as string | null;
    const taskCtx = task.context as Record<string, unknown> | null;
    const isBypassHeld = hasBypassFlag(taskCtx, BYPASS_HELD_GATE_KEY);
    if (missionId && !isBypassHeld && !forceOverride) {
      const isHeld = await checkMissionHeld(missionId);
      if (isHeld) {
        return NextResponse.json({
          error: 'Task is blocked: parent mission is held. Arm the mission or use forceOverride to bypass.',
          gateReason: 'mission_held',
          blockClass: 'policy',
          missionId,
          canForce: true,
        }, { status: 422 });
      }
    }

    // ── Local-executor gate ─────────────────────────────────────────────────
    // A mission with executor='local' runs in a person's own session: runners
    // never auto-claim its tasks, so Start would broadcast into the void. Force
    // start dispatches it to a runner anyway (bypassHeldGate, written below,
    // lifts the claim route's local gate too).
    if (missionId && !isBypassHeld && !forceOverride) {
      if (await checkMissionLocal(missionId)) {
        return NextResponse.json({
          error: 'This mission runs in a local session: runners do not pick up its tasks. Claim it from your session with claim_task, or use forceOverride to hand it to a runner.',
          gateReason: 'mission_local',
          blockClass: 'policy',
          missionId,
          canForce: true,
        }, { status: 422 });
      }
    }

    // ── Mission budget gate ─────────────────────────────────────────────────
    // Mirrors mission gate #1 in the claim loop. `budget_exhausted` is a
    // one-way door: only a human raising costBudgetUsd clears it
    // (api/missions/[id] auto-resume), and it strands EVERY task in the mission
    // at once. Until this gate existed, /start returned 200 and dispatched
    // nothing while each task page rendered a plain QUEUED row.
    const isBypassMissionBudget = hasBypassFlag(taskCtx, BYPASS_MISSION_BUDGET_KEY);
    let missionBudgetExhausted = false;
    if (missionId && !isBypassMissionBudget) {
      missionBudgetExhausted = await checkMissionBudgetExhausted(missionId);
      if (missionBudgetExhausted && !forceOverride) {
        return NextResponse.json({
          error: 'Task is blocked: its mission has exhausted its cost budget, so no worker can claim it. Raise the mission budget to resume every task, or force-start this one.',
          gateReason: 'mission_budget_exhausted',
          blockClass: 'policy',
          missionId,
          canForce: true,
        }, { status: 422 });
      }
    }

    // ── Subject-liveness gate ───────────────────────────────────────────────
    // Mirrors subjectLivenessCondition() in claim/route.ts. A task whose subject
    // PR was reconciled (closed/merged, no live successor) is excluded from the
    // claim query, so starting it broadcasts into the void — the button appeared
    // to work and nothing ever happened. Only anchors that genuinely identify
    // the subject count (source ∈ system|context); a PR number scraped from
    // prose is advisory and never blocks. isSubjectDead() already honors
    // context.bypassSubjectGate, so an earlier force-start passes straight
    // through.
    const subjectDead = isSubjectDead({
      subjectKind: (task as any).subjectKind,
      subjectPrNumber: (task as any).subjectPrNumber,
      subjectResolution: (task as any).subjectResolution,
      subjectAnchor: (task as any).subjectAnchor,
      context: task.context as Record<string, unknown> | null,
    });
    if (subjectDead && !forceOverride) {
      return NextResponse.json({
        error: `Task is blocked: its subject PR #${(task as any).subjectPrNumber} is closed/merged with no live successor, so no worker can claim it. Force-start to run it anyway, or cancel the task.`,
        gateReason: 'subject_dead',
        blockClass: 'policy',
        subjectKind: (task as any).subjectKind ?? null,
        subjectPrNumber: (task as any).subjectPrNumber ?? null,
        subjectResolution: (task as any).subjectResolution ?? null,
        canForce: true,
      }, { status: 422 });
    }

    // ── Workspace concurrency cap gate ──────────────────────────────────────
    // Only repo-backed workspaces are capped; repo-less ones (coordination
    // workspaces) are never serialized.
    // capExempt=true bypasses the cap for this one task without changing the
    // workspace setting. The flag is persisted to context so the claim route
    // also skips the per-task cap check at claim time.
    const wsForCap = task.workspace as { repo?: string | null; maxConcurrentTasks?: number | null } | undefined;
    const taskCtxForCap = task.context as Record<string, unknown> | null;
    const isCapExemptAlready = hasBypassFlag(taskCtxForCap, CAP_EXEMPT_KEY);
    if (wsForCap?.repo && !capExempt && !isCapExemptAlready) {
      // A mission may raise the effective cap above the workspace default —
      // match the GREATEST(workspaceCap, missionCap) logic in the claim route.
      let missionMaxConcurrent: number | null = null;
      if (missionId) {
        const missionRow = await db.query.missions.findFirst({
          where: eq(missions.id, missionId),
          columns: { maxConcurrentTasks: true },
        });
        missionMaxConcurrent = missionRow?.maxConcurrentTasks ?? null;
      }
      const capResult = await checkWorkspaceCap(
        task.workspaceId,
        wsForCap.maxConcurrentTasks ?? null,
        missionMaxConcurrent,
      );
      if (capResult) {
        // Count other pending tasks to surface queue position in the UI.
        const pendingAhead = await db.query.tasks.findMany({
          where: and(
            eq(tasks.workspaceId, task.workspaceId),
            eq(tasks.status, 'pending'),
            ne(tasks.id, taskId),
          ),
          columns: { id: true },
        });
        return NextResponse.json({
          error: `Task cannot be started: workspace is at its concurrency limit (${capResult.active}/${capResult.cap} active tasks)`,
          gateReason: 'workspace_cap_reached',
          blockClass: 'policy',
          active: capResult.active,
          cap: capResult.cap,
          queuePosition: pendingAhead.length,
          canExempt: true,
        }, { status: 422 });
      }
    }

    // ── Commercial entitlement (managed runners) ────────────────────────────
    // Only a task a managed runner already deferred carries the stamp, so a
    // self-hosted team never reaches the check. Re-evaluated with fresh
    // numbers: a limit that has lifted lets the start through (the claim
    // clears the stamp). Not forceable and not an error: the task stays
    // queued and the dashboard shows the entitlement state.
    const entitlementTeamId = (task.workspace as { teamId?: string | null } | undefined)?.teamId;
    if (entitlementTeamId && (task.context as Record<string, unknown> | null)?.[ENTITLEMENT_BLOCK_CONTEXT_KEY]) {
      const block = await checkManagedRunnerEntitlement(entitlementTeamId);
      if (block) {
        return NextResponse.json({
          error: block.kind === 'concurrency'
            ? `Queued: ${block.active} of ${block.limit} managed runs are active. It starts when one finishes.`
            : `Queued: this month's ${block.limit} managed runner-hours are used. It starts when the allowance refills or grows.`,
          gateReason: 'entitlement_blocked',
          blockClass: 'entitlement',
          entitlement: block,
          canForce: false,
        }, { status: 422 });
      }
    }

    // ── Coordination gates ──────────────────────────────────────────────────
    // The claim loop's in-loop gates: path overlap with an open PR or a live
    // path claim, mission concurrency and pacing, one scope-undeclared task
    // per mission, planner order. /start used to accept a task these held, so
    // the page said "Queued at front · No runner has responded" while an idle
    // runner deferred it on every poll. Same predicates as the claim route
    // (claim/coordination-gates). A probe read failure (null) falls back to
    // the old behaviour rather than blocking the start.
    const now = new Date();
    const waitingReasons: WaitingReason[] = (await probeCoordination(task as any, now)) ?? [];
    const blocking = blockingReasons(waitingReasons);
    let forceIntent: ForceStartIntent | null = null;
    if (blocking.length > 0) {
      const refusal = coordinationRefusal(blocking);
      if (!forceCoordination) {
        return NextResponse.json(refusal, { status: 422 });
      }
      if (forceCoordination.reasonsDigest !== refusal.reasonsDigest) {
        return NextResponse.json({
          ...refusal,
          error: `What holds this task changed since you confirmed. ${refusal.error}`,
          reasonsChanged: true,
        }, { status: 409 });
      }
      if (!refusal.canForce) {
        return NextResponse.json(refusal, { status: 422 });
      }
      forceIntent = buildForceStartIntent({
        reasons: blocking,
        userId,
        accountId,
        now,
        note: typeof forceCoordination.note === 'string' ? forceCoordination.note : null,
      });
    }

    // Always stamp manualStartAt so the task is durably prioritized on next claim cycle
    // even if the Pusher broadcast is missed. Also boost priority once to float it
    // above other same-priority tasks. Human-override bypass flags are written here too.
    // bypassDepsGate — skip the dep-PR merge gate (when deps exist).
    // bypassHeldGate — skip the mission held gate (when the task belongs to a mission).
    // bypassMissionBudget — skip the mission budget_exhausted gate.
    // bypassSubjectGate — skip the subject-liveness gate (when the subject PR is dead).
    // capExempt — allow this single task to run as a 4th+ slot (one-time exception).
    //
    // There is deliberately NO bypassStartGate: the deferred-start override is
    // expressed by clearing startAt below, which is the only thing the claim
    // route reads. The old flag was written here and read by nothing — an
    // operator-visible context key that looked like a working override.
    const hasDeps = dependsOn.length > 0;
    const hasStartGate = !!(task.startAt && task.startAt > new Date());
    const hasMission = !!task.missionId;
    const existingContext = (task.context as Record<string, unknown>) || {};
    const alreadyManualStarted = !!existingContext.manualStartAt;

    await db
      .update(tasks)
      .set({
        context: {
          ...existingContext,
          manualStartAt: now.toISOString(),
          ...(forceOverride && hasDeps ? { bypassDepsGate: true } : {}),
          ...(forceOverride && hasMission ? { bypassHeldGate: true } : {}),
          ...(forceOverride && missionBudgetExhausted ? { [BYPASS_MISSION_BUDGET_KEY]: true } : {}),
          ...(forceOverride && subjectDead ? { [BYPASS_SUBJECT_GATE_KEY]: true } : {}),
          ...(capExempt ? { capExempt: true } : {}),
          ...(forceIntent ? { [FORCE_START_CONTEXT_KEY]: forceIntent } : {}),
        },
        // Boost priority once on first manual start so task floats to top of claim queue.
        // Idempotent: re-poking ('Poke workers again') does not compound the boost.
        ...(!alreadyManualStarted ? { priority: (task.priority ?? 0) + 1 } : {}),
        ...(forceOverride && hasStartGate ? { startAt: null } : {}),
        updatedAt: now,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, 'pending')));

    console.log(JSON.stringify({
      event: 'start_broadcast',
      taskId: task.id,
      workspaceId: task.workspaceId,
      manualStartAt: now.toISOString(),
      targetLocalUiUrl: targetLocalUiUrl || null,
    }));

    if (forceIntent) {
      recordForceStartRequest({
        intent: forceIntent,
        task: { id: task.id, workspaceId: task.workspaceId, missionId: task.missionId ?? null },
        callerOrigin: authType === 'session' ? 'dashboard' : 'api',
      });
    }

    // The wake re-evaluates; the claim route still applies every gate this
    // route did not override. Delivery sends the (targeted) TASK_ASSIGNED.
    // A force start is honoured by THAT claim (a runner's), never by a claim
    // made here: this route creates no worker.
    await wakeTask(task.id, 'manual.start', { targetLocalUiUrl: targetLocalUiUrl || null });

    return NextResponse.json({
      started: true,
      taskId: task.id,
      targetLocalUiUrl: targetLocalUiUrl || null,
      // Soft reasons (planner order) only order the task; shown, never refused.
      ...(waitingReasons.length > 0 && !forceIntent ? { waitingReasons } : {}),
      ...(forceIntent ? {
        forced: {
          forceId: forceIntent.id,
          gates: forceIntent.kinds.map(gateName),
          railsRemaining: railsRemainingFor(blocking).map(r => RAIL_TEXT[r]),
          expiresAt: forceIntent.expiresAt,
        },
      } : {}),
    });
  } catch (error) {
    console.error('Start task error:', error);
    return NextResponse.json({ error: 'Failed to start task' }, { status: 500 });
  }
}

/**
 * The 422 body for a start a coordination gate holds: the canonical reasons,
 * their digest (echoed back to confirm a force), and — when every one is
 * forceable — exactly which gates a force lifts and which rails remain.
 */
function coordinationRefusal(blocking: WaitingReason[]) {
  const head = blocking[0];
  const canForce = canForceStart(blocking);
  const notForceable = blocking.filter(r => !r.action.force);
  return {
    error: `${waitingHeadline(head)} because ${head.because}. Starts when ${head.releasesWhen.text}.`,
    gateReason: 'coordination_hold',
    blockClass: 'policy' as const,
    waitingReasons: blocking,
    reasonsDigest: waitingReasonsDigest(blocking),
    canForce,
    force: canForce
      ? { gates: [...new Set(blocking.map(r => gateName(r.kind)))], railsRemaining: railsRemainingFor(blocking).map(r => RAIL_TEXT[r]) }
      : null,
    ...(notForceable.length > 0 ? { notForceable: notForceable.map(r => gateName(r.kind)) } : {}),
  };
}
