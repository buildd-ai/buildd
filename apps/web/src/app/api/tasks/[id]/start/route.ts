import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers, accountWorkspaces, workspaces } from '@buildd/core/db/schema';
import { eq, and, or, isNull, isNotNull, inArray, ne } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { checkConnectorRouting, findAlternativeRole, checkMissionHeld, checkWorkspaceCap, checkCapabilityMatch, type ConnectorFailure } from '@/lib/claim-gates';

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
    // Mirrors the connectorMismatchTaskIds pre-filter in claim/route.ts.
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
    // Mirrors missionNotHeld() SQL condition in claim/route.ts.
    // Held missions block all task claims until armed. forceOverride bypasses
    // this gate (the bypassHeldGate context key is written below).
    const missionId = (task as any).missionId as string | null;
    const taskCtx = task.context as Record<string, unknown> | null;
    const isBypassHeld = taskCtx?.bypassHeldGate === true || taskCtx?.bypassHeldGate === 'true';
    if (missionId && !isBypassHeld && !forceOverride) {
      const isHeld = await checkMissionHeld(missionId);
      if (isHeld) {
        return NextResponse.json({
          error: 'Task is blocked: parent mission is held. Arm the mission or use forceOverride to bypass.',
          gateReason: 'mission_held',
          missionId,
          canForce: true,
        }, { status: 422 });
      }
    }

    // ── Workspace concurrency cap gate ──────────────────────────────────────
    // Mirrors the per-repo worker-count SQL condition in claim/route.ts.
    // Only repo-backed workspaces are capped; repo-less ones (coordination
    // workspaces) are never serialized.
    // capExempt=true bypasses the cap for this one task without changing the
    // workspace setting. The flag is persisted to context so the claim route
    // also skips the per-task cap check at claim time.
    const wsForCap = task.workspace as { repo?: string | null; maxConcurrentTasks?: number | null } | undefined;
    const taskCtxForCap = task.context as Record<string, unknown> | null;
    const isCapExemptAlready = taskCtxForCap?.capExempt === true;
    if (wsForCap?.repo && !capExempt && !isCapExemptAlready) {
      const capResult = await checkWorkspaceCap(
        task.workspaceId,
        wsForCap.maxConcurrentTasks ?? null,
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
          active: capResult.active,
          cap: capResult.cap,
          queuePosition: pendingAhead.length,
          canExempt: true,
        }, { status: 422 });
      }
    }

    // ── Capability / backend gate ───────────────────────────────────────────────
    // Mirrors the capability filter (filteredTasks) in claim/route.ts.
    // Codex-backend tasks need server-side credentials OR a local-auth runner.
    // We can only verify server-side credentials here; a local runner with
    // OPENAI_API_KEY/CODEX_HOME still bypasses this gate at claim time.
    const taskBackend = (task as any).backend as string | null;
    if (taskBackend && teamId && !forceOverride) {
      const missingCap = await checkCapabilityMatch({
        backend: taskBackend,
        workspaceId: task.workspaceId,
        teamId,
        accountId: accountId ?? null,
      });
      if (missingCap) {
        return NextResponse.json({
          error: `Task cannot be started: '${taskBackend}' backend is not available (no server credentials configured)`,
          gateReason: 'capability_mismatch',
          missingCapability: missingCap,
          canForce: true,
        }, { status: 422 });
      }
    }

    // Always stamp manualStartAt so the task is durably prioritized on next claim cycle
    // even if the Pusher broadcast is missed. Also boost priority once to float it
    // above other same-priority tasks. Human-override bypass flags are written here too.
    // bypassDepsGate — skip the dep-PR merge gate (when deps exist).
    // bypassStartGate — skip the deferred-start floor (when startAt is in future).
    // bypassHeldGate — skip the mission held gate (when the task belongs to a mission).
    // capExempt — allow this single task to run as a 4th+ slot (one-time exception).
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
          ...(forceOverride && hasStartGate ? { bypassStartGate: true } : {}),
          ...(forceOverride && hasMission ? { bypassHeldGate: true } : {}),
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
