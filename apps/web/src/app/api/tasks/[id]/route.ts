import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers, artifacts } from '@buildd/core/db/schema';
import { and, eq, inArray, desc } from 'drizzle-orm';
import { validateRequiredConnectors } from '@/lib/required-connectors';

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
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { resolveCompletedTask } from '@/lib/task-dependencies';
import { applyTaskCancelSideEffects, emitTaskUpdated } from '@/lib/task-cancel';
import { dispatchUnblockedTask } from '@/lib/task-dispatch';
import { parseLoopConfig } from '@buildd/core/loop-config';
import { readModelPin, isTaskTier, isAcceptableModelPin } from '@buildd/core/model-pin';
import { TIERS } from '@buildd/core/model-tier-defaults';
import { appBaseUrl } from '@/lib/app-url';

/**
 * Nudge runners for a task just reset to pending — but only when nothing it
 * dependsOn is still outstanding. Mirrors checkDependsOnResolved's rule (every
 * dep completed, looping deps satisfied) minus its open-PR check; the claim
 * route still enforces the merged-PR gate, so this is only a wake-up.
 */
async function dispatchIfDependenciesSatisfied(
  task: typeof tasks.$inferSelect,
  workspace: Parameters<typeof dispatchUnblockedTask>[1] | null | undefined,
): Promise<void> {
  const deps = (task.dependsOn as string[] | null) ?? [];
  if (deps.length > 0) {
    const depRows = await db.query.tasks.findMany({
      where: inArray(tasks.id, deps),
      columns: { id: true, status: true, loopState: true },
    });
    const byId = new Map(depRows.map((d) => [d.id, d]));
    const satisfied = deps.every((depId) => {
      const dep = byId.get(depId);
      return dep?.status === 'completed' && (dep.loopState == null || dep.loopState === 'satisfied');
    });
    if (!satisfied) return;
  }
  await dispatchUnblockedTask(task, workspace ?? {});
}

// GET /api/tasks/[id] - Get a single task.
// Query params:
//   include=workers,artifacts — opt-in expansion. `workers` returns all worker
//     attempts (latest first) with PR refs, summary, error, status, branch,
//     completedAt. `artifacts` returns artifacts attached to those workers,
//     each with a shareUrl.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Dev mode returns mock task data so polling doesn't break
  if (process.env.NODE_ENV === 'development' && !process.env.DATABASE_URL) {
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
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const idError = validateTaskId(id);
  if (idError) return idError;

  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, id),
      with: {
        workspace: true,
        mission: { columns: { id: true, title: true, status: true } },
      },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Verify access
    if (user && !apiAccount) {
      const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
      if (!access) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    } else if (apiAccount) {
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, task.workspaceId);
      if (!hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const includeRaw = req.nextUrl.searchParams.get('include') || '';
    const include = new Set(includeRaw.split(',').map(s => s.trim()).filter(Boolean));

    let taskWorkers: any[] | undefined;
    let taskArtifacts: any[] | undefined;

    if (include.has('workers') || include.has('artifacts')) {
      taskWorkers = await db.query.workers.findMany({
        where: eq(workers.taskId, id),
        orderBy: [desc(workers.createdAt)],
        columns: {
          id: true,
          status: true,
          branch: true,
          prUrl: true,
          prNumber: true,
          error: true,
          currentAction: true,
          startedAt: true,
          completedAt: true,
          lastCommitSha: true,
          commitCount: true,
          filesChanged: true,
          linesAdded: true,
          linesRemoved: true,
          supersededByPrNumber: true,
          supersededByPrUrl: true,
          supersededReason: true,
          supersededRecordedBy: true,
          supersededAt: true,
          turns: true,
          inputTokens: true,
          outputTokens: true,
          costUsd: true,
          createdAt: true,
          // A gate-rejected completion (outputRequirement 400) persists the
          // agent's summary here instead of discarding it — but until now
          // nothing read it back, so a rejected 60-turn run's only trace was
          // the raw 400 text in `error`. Surfaced read-only: never a
          // satisfied deliverable, just the salvage record of a refused one.
          rejectedCompletionPayload: true,
        },
      });
    }

    if (include.has('artifacts') && taskWorkers && taskWorkers.length > 0) {
      const workerIds = taskWorkers.map(w => w.id);
      const rows = await db.query.artifacts.findMany({
        where: inArray(artifacts.workerId, workerIds),
        orderBy: [desc(artifacts.updatedAt)],
      });
      const baseUrl = appBaseUrl();
      taskArtifacts = rows.map(a => ({
        ...a,
        shareUrl: a.shareToken && a.visibility === 'public' ? `${baseUrl}/share/${a.shareToken}` : null,
      }));
    }

    const response: Record<string, unknown> = { ...task };
    if (taskWorkers !== undefined) response.workers = taskWorkers;
    if (taskArtifacts !== undefined) response.artifacts = taskArtifacts;

    return NextResponse.json(response);
  } catch (error) {
    console.error('Get task error:', error);
    return NextResponse.json({ error: 'Failed to get task' }, { status: 500 });
  }
}

// PATCH /api/tasks/[id] - Update a task
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Dev mode returns mock
  if (process.env.NODE_ENV === 'development' && !process.env.DATABASE_URL) {
    return NextResponse.json({ id, title: 'Updated Task' });
  }

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const patchIdError = validateTaskId(id);
  if (patchIdError) return patchIdError;

  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, id),
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
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, task.workspaceId);
      if (!hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const body = await req.json();
    const { title, description, priority, project, missionId, dependsOn, status, roleSlug, requiredConnectors: rawRequiredConnectors, externalIssueId, externalIssueUrl, backend, tier, model, maxLoops, actorWorkerId, resultSummary, correctedBy } = body;

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
    if (roleSlug !== undefined) updateData.roleSlug = roleSlug || null;
    // Link (or unlink) the task to an external issue tracker item (e.g. a Linear
    // issue). Setting this is what enables the PR-merge completion comment in the
    // GitHub webhook (maybePostWorkTrackerIssueUpdate reads task.externalIssueId).
    if (externalIssueId !== undefined) updateData.externalIssueId = externalIssueId || null;
    if (externalIssueUrl !== undefined) updateData.externalIssueUrl = externalIssueUrl || null;
    if (missionId !== undefined) updateData.missionId = missionId || null;
    if (dependsOn !== undefined) {
      if (!Array.isArray(dependsOn) || !dependsOn.every((id: unknown) => typeof id === 'string')) {
        return NextResponse.json({ error: 'dependsOn must be an array of task IDs' }, { status: 400 });
      }
      updateData.dependsOn = dependsOn;
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
      if (apiAccount && apiAccount.level !== 'admin') {
        return NextResponse.json({ error: 'Correcting a task result requires an admin-level token' }, { status: 403 });
      }
      if (typeof resultSummary !== 'string' || resultSummary.trim() === '') {
        return NextResponse.json({ error: 'resultSummary must be a non-empty string' }, { status: 400 });
      }
      if (!['completed', 'failed'].includes(task.status)) {
        return NextResponse.json(
          { error: `Cannot correct result.summary on a '${task.status}' task — only completed or failed tasks have a stored result to correct.` },
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
          where: and(
            eq(workers.taskId, id),
            inArray(workers.status, ['running', 'waiting_input']),
          ),
        });
        if (activeWorker) {
          return NextResponse.json(
            { error: 'Cannot change status directly — task has an active worker. Use complete_task via the worker instead.' },
            { status: 409 }
          );
        }
      }
      updateData.status = status;

      // When resetting to pending, clear claim fields so the task is claimable again
      if (status === 'pending') {
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
          await dispatchIfDependenciesSatisfied(updated, task.workspace).catch((err) =>
            console.error('[task-patch] pending dispatch failed:', err)
          );
        }
      }
    }

    // When a task transitions to a non-terminal status (un-cancel, re-open, or new
    // missionId link), reopen the mission if it's currently completed. Idempotent.
    const isNowOpen = status !== undefined && !['completed', 'failed', 'cancelled'].includes(status as string);
    const missionLinkAdded = missionId !== undefined && updated?.missionId && updated.missionId !== task.missionId;
    const missionUnlinked = missionId !== undefined && !updated?.missionId && task.missionId;

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

    return NextResponse.json(updated);
  } catch (error) {
    console.error('Update task error:', error);
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
}

// DELETE /api/tasks/[id] - Delete a task (only pending tasks)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Dev mode returns success
  if (process.env.NODE_ENV === 'development' && !process.env.DATABASE_URL) {
    return NextResponse.json({ success: true });
  }

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, id),
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
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, task.workspaceId);
      if (!hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // ?force=true skips status check (for test cleanup scripts)
    const force = req.nextUrl.searchParams.get('force') === 'true';

    if (!force) {
      // Only allow deleting pending, assigned, failed, completed, or cancelled tasks (not actively running)
      if (!['pending', 'assigned', 'failed', 'completed', 'cancelled'].includes(task.status)) {
        return NextResponse.json(
          { error: `Cannot delete ${task.status} tasks. Wait for completion or use reassign.` },
          { status: 400 }
        );
      }
    }

    await db.delete(tasks).where(eq(tasks.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete task error:', error);
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 });
  }
}
