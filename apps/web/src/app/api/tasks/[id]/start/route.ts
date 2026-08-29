import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers, missions } from '@buildd/core/db/schema';
import { eq, and, isNull, isNotNull, inArray, ne } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { checkConnectorRouting, findAlternativeRole, type ConnectorFailure } from '../../../workers/claim/connector-gate';
import { checkMissionHeld } from '../../../workers/claim/held-gate';
import { checkMissionBudgetExhausted } from '../../../workers/claim/mission-budget-gate';
import { checkWorkspaceCap } from '../../../workers/claim/workspace-cap-gate';
import { BYPASS_SUBJECT_GATE_KEY, isSubjectDead } from '@/lib/subject-gate-contract';
import { BYPASS_HELD_GATE_KEY, BYPASS_MISSION_BUDGET_KEY, CAP_EXEMPT_KEY, hasBypassFlag } from '@/lib/bypass-flags';

/**
 * POST /api/tasks/[id]/start
 *
 * Start a pending task by notifying workers to claim it.
 * Supports dual auth: API key (Bearer) or session cookie.
 * - Broadcasts TASK_ASSIGNED event to workers
 * - Optionally targets a specific runner instance
 *
 * Body:
 * - targetLocalUiUrl?: string - Specific runner to assign to (optional)
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
    const account = await authenticateApiKey(apiKey);
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
    const now = new Date();

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

    // Build minimal task payload for Pusher (10KB event limit).
    // Full task data (with context, attachments, workspace config) is fetched
    // via the claim API. Sending the full object can exceed Pusher's limit
    // and cause silent delivery failure.
    const taskPayload = {
      id: task.id,
      title: task.title,
      description: task.description,
      workspaceId: task.workspaceId,
      status: task.status,
      mode: task.mode,
      priority: task.priority,
      workspace: task.workspace ? {
        name: task.workspace.name,
        repo: task.workspace.repo,
      } : undefined,
    };

    // Broadcast to workers
    // If targetLocalUiUrl is provided, only that worker will claim it
    // Otherwise, any available worker can claim it
    await triggerEvent(
      channels.workspace(task.workspaceId),
      events.TASK_ASSIGNED,
      { task: taskPayload, targetLocalUiUrl: targetLocalUiUrl || null }
    );

    return NextResponse.json({
      started: true,
      taskId: task.id,
      targetLocalUiUrl: targetLocalUiUrl || null,
    });
  } catch (error) {
    console.error('Start task error:', error);
    return NextResponse.json({ error: 'Failed to start task' }, { status: 500 });
  }
}
