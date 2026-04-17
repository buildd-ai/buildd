import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, tasks, artifacts, workspaces, githubRepos, missionNotes, accounts, tenantBudgets } from '@buildd/core/db/schema';
import { githubApi } from '@/lib/github';
import { eq, and, desc, inArray, isNull, sql } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveCompletedTask } from '@/lib/task-dependencies';
import { checkWorkerDeliverables, getWorkerArtifactCount } from '@/lib/worker-deliverables';
import { jsonResponse } from '@/lib/api-response';
import { notify } from '@/lib/pushover';
import { notifySlack } from '@/lib/slack-notify';
import { notifyDiscord } from '@/lib/discord-notify';
import { sendTaskCallback } from '@/lib/task-callback';
import { upsertAutoArtifact, formatStructuredOutput } from '@/lib/artifact-helpers';
import { recordTaskOutcome } from '@buildd/core/routing-analytics';

// GET /api/workers/[id] - Get worker details
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    with: { task: true, workspace: true },
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  if (worker.accountId !== account.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json(worker);
}

// PATCH /api/workers/[id] - Update worker status
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  if (worker.accountId !== account.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();

  // Check if worker was already terminated (reassigned/failed)
  // Allow reactivation with 'running' status for follow-up messages from runner,
  // but NOT if the worker was auto-expired by cleanup (stale/timeout/heartbeat).
  if (worker.status === 'failed' || worker.status === 'completed' || worker.status === 'error') {
    const isCleanupExpiry = worker.error?.includes('expired') ||
      worker.error?.includes('timed out') ||
      worker.error?.includes('went offline') ||
      worker.error?.includes('runner restarted');
    if (body.status !== 'running' || isCleanupExpiry) {
      // Enrich 409 with deliverable info so the runner can distinguish
      // "already completed successfully" from "genuinely terminated/reassigned"
      const artifactCount = await getWorkerArtifactCount(id);
      const deliverables = checkWorkerDeliverables(worker, { artifactCount });
      return NextResponse.json({
        error: (worker.status === 'failed' || worker.status === 'error')
          ? 'Worker was terminated - task may have been reassigned'
          : 'Worker already completed',
        abort: true,
        reason: worker.error || worker.status,
        actualStatus: worker.status,
        hasDeliverables: deliverables.hasAny,
      }, { status: 409 });
    }
    // Reactivation: clear completion timestamp so worker can run again
  }
  const {
    status, error, costUsd, turns, localUiUrl, currentAction, milestones,
    appendMilestones,
    appendMcpCalls,
    waitingFor,
    // Token usage
    inputTokens, outputTokens,
    // Git stats
    lastCommitSha, commitCount, filesChanged, linesAdded, linesRemoved,
    // SDK result metadata
    resultMeta,
    // Transient subagent progress (not persisted — forwarded via Pusher only)
    taskProgress,
  } = body;

  const updates: Partial<typeof workers.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (status) updates.status = status;
  if (error !== undefined) updates.error = error;
  if (typeof costUsd === 'number') updates.costUsd = costUsd.toString();
  if (typeof inputTokens === 'number') updates.inputTokens = inputTokens;
  if (typeof outputTokens === 'number') updates.outputTokens = outputTokens;
  if (typeof turns === 'number') updates.turns = turns;
  // Infer turns from resultMeta.numTurns when not explicitly provided (external runners send resultMeta but not turns)
  else if (resultMeta && typeof resultMeta.numTurns === 'number' && resultMeta.numTurns > 0) updates.turns = resultMeta.numTurns;
  // Auto-increment turns for MCP workers that don't send explicit turn counts
  else updates.turns = sql`${workers.turns} + 1` as any;
  if (localUiUrl !== undefined) updates.localUiUrl = localUiUrl;
  if (currentAction !== undefined) updates.currentAction = currentAction;
  if (milestones !== undefined) updates.milestones = milestones;
  // appendMilestones: merge new milestones into existing (for MCP workers)
  if (appendMilestones && Array.isArray(appendMilestones)) {
    const existing = (worker.milestones as any[]) || [];
    const merged = [...existing, ...appendMilestones];
    updates.milestones = merged.length > 50 ? merged.slice(-50) : merged;
  }
  // appendMcpCalls: merge new MCP tool calls into existing log
  if (appendMcpCalls && Array.isArray(appendMcpCalls)) {
    const existing = (worker.mcpCalls as any[]) || [];
    const merged = [...existing, ...appendMcpCalls];
    updates.mcpCalls = merged.length > 100 ? merged.slice(-100) : merged;
  }
  // Git stats
  if (lastCommitSha !== undefined) updates.lastCommitSha = lastCommitSha;
  if (typeof commitCount === 'number') updates.commitCount = commitCount;
  if (typeof filesChanged === 'number') updates.filesChanged = filesChanged;
  if (typeof linesAdded === 'number') updates.linesAdded = linesAdded;
  if (typeof linesRemoved === 'number') updates.linesRemoved = linesRemoved;
  // Waiting state
  if (waitingFor !== undefined) updates.waitingFor = waitingFor;
  // Pushover notification when agent needs input
  if (waitingFor?.type === 'question') {
    notify({
      app: 'tasks',
      title: 'Agent needs your input',
      message: (waitingFor.prompt || 'A task needs your response').slice(0, 200),
      url: `https://app.buildd.dev/app/tasks/${worker.taskId}`,
      urlTitle: 'Respond',
      priority: 0,
    });
  }
  // Auto-clear waitingFor when worker resumes running
  if (status === 'running' && waitingFor === undefined) updates.waitingFor = null;
  // SDK result metadata
  if (resultMeta !== undefined) updates.resultMeta = resultMeta;

  // Status audit trail: record terminal transitions in milestones for debugging
  if (status === 'completed' || status === 'failed') {
    const existingMilestones = (updates.milestones ?? worker.milestones ?? []) as any[];
    const transition = {
      type: 'statusTransition',
      label: `Status: ${worker.status} → ${status}`,
      from: worker.status,
      to: status,
      ts: Date.now(),
      source: 'api',
    };
    updates.milestones = [...existingMilestones, transition];
  }

  // Handle status transitions
  if (status === 'running' && !worker.startedAt) {
    updates.startedAt = new Date();
  }
  // Reactivation: clear completion state when worker resumes from completed/failed/error
  if (status === 'running' && (worker.status === 'completed' || worker.status === 'failed' || worker.status === 'error')) {
    updates.completedAt = null;
    updates.error = null;

    // Reactivate the associated task
    if (worker.taskId) {
      await db
        .update(tasks)
        .set({ status: 'assigned', updatedAt: new Date() })
        .where(eq(tasks.id, worker.taskId));
    }
  }
  // Enforce output requirement based on task.outputRequirement
  // (Must run BEFORE task status update to prevent marking task completed on validation failure)
  // Note: only pr_required and artifact_required are hard blockers (400).
  // auto mode logs a warning but allows completion — agents may create PRs via
  // gh pr create without using the buildd create_pr action.
  let outputWarning: string | undefined;
  if (status === 'completed') {
    // Fetch task to check outputRequirement
    const task = worker.taskId
      ? await db.query.tasks.findFirst({ where: eq(tasks.id, worker.taskId) })
      : null;
    const outputReq = (task as any)?.outputRequirement ?? 'auto';

    if (outputReq !== 'none') {
      const effectiveCommits = commitCount ?? worker.commitCount ?? 0;
      let hasPR = !!worker.prUrl;

      // Auto-detect: if no PR on worker but branch exists, check GitHub for PRs
      if (!hasPR && worker.branch) {
        const workspace = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, worker.workspaceId),
        });
        if (workspace?.githubRepoId) {
          const repo = await db.query.githubRepos.findFirst({
            where: eq(githubRepos.id, workspace.githubRepoId),
            with: { installation: true },
          });
          if (repo?.installation) {
            try {
              const owner = repo.fullName.split('/')[0];
              const prs = await githubApi(
                repo.installation.installationId,
                `/repos/${repo.fullName}/pulls?head=${encodeURIComponent(owner + ':' + worker.branch)}&state=open`,
              );
              if (Array.isArray(prs) && prs.length > 0) {
                // Found PR — update worker and let validation pass
                await db.update(workers).set({
                  prUrl: prs[0].html_url,
                  prNumber: prs[0].number,
                  updatedAt: new Date(),
                }).where(eq(workers.id, id));
                hasPR = true;
              }
            } catch { /* non-fatal — fall through to normal validation */ }
          }
        }
      }

      // pr_required: always require a PR (regardless of commits)
      if (outputReq === 'pr_required' && !hasPR) {
        return NextResponse.json({
          error: 'This task requires a pull request before completing. Use create_pr to open one.',
          hint: 'create_pr',
        }, { status: 400 });
      }

      // artifact_required: require PR or artifact (regardless of commits)
      if (outputReq === 'artifact_required' && !hasPR) {
        const workerArtifacts = await db.query.artifacts.findMany({
          where: eq(artifacts.workerId, id),
        });
        if (workerArtifacts.length === 0) {
          return NextResponse.json({
            error: 'This task requires a deliverable before completing. Use create_pr or create_artifact.',
            hint: 'create_pr or create_artifact',
          }, { status: 400 });
        }
      }

      // auto (default): warn but allow completion — agent may have created PR via git CLI
      if (outputReq === 'auto' && effectiveCommits > 0 && !hasPR) {
        const workerArtifacts = await db.query.artifacts.findMany({
          where: eq(artifacts.workerId, id),
        });
        if (workerArtifacts.length === 0) {
          outputWarning = `Task has ${effectiveCommits} commit(s) but no tracked PR or artifact. Use create_pr next time for better tracking.`;
        }
      }
    }
  }

  // Budget exhaustion detection: check if this is a budget-related failure
  const isBudgetError = status === 'failed' && (
    body.budgetExhausted === true ||
    isBudgetExhaustionError(error)
  );
  let isBudgetReset = false;

  if (isBudgetError && worker.taskId) {
    // Parse reset time from error message, default to 5 hours from now
    const defaultResetMs = 5 * 60 * 60 * 1000;
    let budgetResetsAt = new Date(Date.now() + defaultResetMs);
    if (typeof error === 'string') {
      const resetMatch = error.match(/resets\s+(\d{1,2}(?:am|pm)?)\s*\((\w+)\)/i);
      if (resetMatch) {
        const parsed = parseResetTime(resetMatch[1]);
        if (parsed) budgetResetsAt = parsed;
      }
    }

    // Fetch the task to get tenant context and workspace teamId
    const taskForBudget = await db.query.tasks.findFirst({
      where: eq(tasks.id, worker.taskId),
      columns: { context: true, workspaceId: true },
      with: { workspace: { columns: { teamId: true } } },
    });
    const budgetTaskCtx = (taskForBudget?.context || {}) as Record<string, unknown>;
    const tenantCtx = budgetTaskCtx.tenantContext as { tenantId?: string } | undefined;
    const teamId = (taskForBudget?.workspace as any)?.teamId as string | undefined;

    if (tenantCtx?.tenantId && teamId) {
      // Tenant-level budget exhaustion: upsert into tenantBudgets
      await db
        .insert(tenantBudgets)
        .values({
          tenantId: tenantCtx.tenantId,
          teamId,
          budgetExhaustedAt: new Date(),
          budgetResetsAt,
        })
        .onConflictDoUpdate({
          target: [tenantBudgets.tenantId, tenantBudgets.teamId],
          set: {
            budgetExhaustedAt: new Date(),
            budgetResetsAt,
            updatedAt: new Date(),
          },
        });
    } else if (account.authType === 'oauth') {
      // Account-level budget exhaustion: set flag (first-writer wins)
      await db
        .update(accounts)
        .set({
          budgetExhaustedAt: new Date(),
          budgetResetsAt,
        })
        .where(and(
          eq(accounts.id, account.id),
          isNull(accounts.budgetExhaustedAt),
        ));
    }

    // Reset task to pending (not failed) — will be retried when budget resets
    const existingCtx = (taskForBudget?.context || {}) as Record<string, unknown>;
    await db
      .update(tasks)
      .set({
        status: 'pending',
        claimedBy: null,
        claimedAt: null,
        expiresAt: null,
        updatedAt: new Date(),
        context: {
          ...existingCtx,
          budgetExhausted: true,
          previousWorkerId: id,
        },
      })
      .where(eq(tasks.id, worker.taskId));

    isBudgetReset = true;
  }

  let shouldAutoRetry = false;
  if (status === 'completed' || status === 'failed') {
    updates.completedAt = new Date();

    // Update task status + snapshot deliverables
    // Skip task update for budget errors — already handled above
    if (worker.taskId && !isBudgetReset) {
      // Auto-retry: mission tasks get 1 automatic retry before permanently failing
      let taskCtxForRetry: Record<string, unknown> = {};
      if (status === 'failed') {
        const taskForRetry = await db.query.tasks.findFirst({
          where: eq(tasks.id, worker.taskId),
          columns: { missionId: true, context: true },
        });
        taskCtxForRetry = (taskForRetry?.context || {}) as Record<string, unknown>;
        const retryCount = (taskCtxForRetry.retryCount as number) || 0;
        const maxRetries = taskForRetry?.missionId ? 1 : 0;
        shouldAutoRetry = retryCount < maxRetries;
        if (shouldAutoRetry) {
          taskCtxForRetry = { ...taskCtxForRetry, retryCount: retryCount + 1 };
        }
      }

      const taskUpdate: Record<string, unknown> = {
        status: shouldAutoRetry ? 'pending' : (status === 'completed' ? 'completed' : 'failed'),
        updatedAt: new Date(),
        ...(shouldAutoRetry ? {
          claimedBy: null,
          claimedAt: null,
          expiresAt: null,
          context: taskCtxForRetry,
        } : {}),
      };

      // Snapshot worker stats into task.result on completion
      if (status === 'completed') {
        // Clean summary: strip shell artifacts like HEREDOC syntax from commit commands
        let summary = body.summary || undefined;
        if (typeof summary === 'string') {
          summary = summary
            .replace(/\$\(cat\s*<<'?EOF'?\n?/g, '')
            .replace(/\nEOF\n?\)\s*"?\s*$/g, '')
            .replace(/\s*Co-Authored-By:.*$/gm, '')
            .trim() || undefined;
        }
        // Extract phase timeline from milestones for result snapshot
        const finalMilestones = (updates.milestones ?? worker.milestones ?? []) as any[];
        const phases = finalMilestones
          .filter((m: any) => m.type === 'phase')
          .map((m: any) => ({ label: m.label, toolCount: m.toolCount }));

        // Capture last question if worker was in waiting state
        const waitingForData = worker.waitingFor as { prompt?: string } | null;
        const lastQuestion = waitingForData?.prompt || undefined;

        // Re-read worker to pick up auto-detected PR fields
        const freshWorker = await db.query.workers.findFirst({
          where: eq(workers.id, id),
        });

        taskUpdate.result = {
          summary,
          branch: worker.branch,
          commits: commitCount ?? worker.commitCount ?? 0,
          sha: lastCommitSha ?? worker.lastCommitSha ?? undefined,
          files: filesChanged ?? worker.filesChanged ?? 0,
          added: linesAdded ?? worker.linesAdded ?? 0,
          removed: linesRemoved ?? worker.linesRemoved ?? 0,
          prUrl: freshWorker?.prUrl ?? worker.prUrl ?? undefined,
          prNumber: freshWorker?.prNumber ?? worker.prNumber ?? undefined,
          ...(phases.length > 0 && { phases }),
          ...(lastQuestion && { lastQuestion }),
          // Structured output from SDK (validated JSON matching task.outputSchema)
          ...(body.structuredOutput && typeof body.structuredOutput === 'object' && { structuredOutput: body.structuredOutput }),
          // Artifact protocol: hint for the orchestrator on what to consider next
          ...(body.nextSuggestion && typeof body.nextSuggestion === 'string' && { nextSuggestion: body.nextSuggestion }),
        };

        // Snapshot unique MCP servers into task result
        const allMcpCalls = (updates.mcpCalls ?? worker.mcpCalls ?? []) as any[];
        if (allMcpCalls.length > 0) {
          (taskUpdate.result as any).mcpServers = [...new Set(allMcpCalls.map((c: any) => c.server))];
        }
      }

      await db
        .update(tasks)
        .set(taskUpdate)
        .where(eq(tasks.id, worker.taskId));

      // Record routing outcome for analytics/calibration. Skipped on retry
      // (we only want one row per terminal outcome). Fire-and-forget.
      if (!shouldAutoRetry) {
        const durationMs = worker.startedAt
          ? Date.now() - new Date(worker.startedAt).getTime()
          : null;
        const retryCount =
          ((taskCtxForRetry.retryCount as number | undefined) ?? 0);
        recordTaskOutcome({
          taskId: worker.taskId,
          accountId: worker.accountId,
          outcome: status,
          totalCostUsd: updates.costUsd ?? worker.costUsd ?? null,
          totalTurns: updates.turns ?? worker.turns ?? null,
          durationMs,
          wasRetried: retryCount > 0,
        }).catch(() => {});
      }

      // Post-completion side effects (non-fatal — must not block worker update)
      try {
        // Log triage outcome for planning tasks (evaluation telemetry)
        if (status === 'completed' && body.structuredOutput?.triageOutcome) {
          const taskForTriage = await db.query.tasks.findFirst({
            where: eq(tasks.id, worker.taskId),
            columns: { mode: true, missionId: true, context: true },
          });
          if (taskForTriage?.mode === 'planning' && taskForTriage.missionId) {
            const ctx = (taskForTriage.context || {}) as Record<string, unknown>;
            const planArr = body.structuredOutput.plan as unknown[] | undefined;
            console.log('[triage]', JSON.stringify({
              missionId: taskForTriage.missionId,
              triageOutcome: body.structuredOutput.triageOutcome,
              tasksCreated: Array.isArray(planArr) ? planArr.length : body.structuredOutput.tasksCreated,
              missionComplete: body.structuredOutput.missionComplete,
              cycleNumber: ctx.cycleNumber,
            }));
          }
        }

        // Resolve dependencies (check if parent's children all completed)
        await resolveCompletedTask(worker.taskId, worker.workspaceId);

        // Auto-create/upsert artifact from structured output or summary
        if (status === 'completed') {
          const taskForArtifact = await db.query.tasks.findFirst({
            where: eq(tasks.id, worker.taskId),
            columns: { context: true, missionId: true, title: true },
          });
          const ctx = (taskForArtifact?.context || {}) as Record<string, unknown>;
          const structuredOutput = body.structuredOutput;
          const summary = body.summary;

          if (structuredOutput || summary) {
            const isHeartbeat = ctx.heartbeat === true;
            const missionId = taskForArtifact?.missionId as string | undefined;
            const missionTitle = ctx.missionTitle as string | undefined;
            const scheduleId = ctx.scheduleId as string | undefined;
            const scheduleName = ctx.scheduleName as string | undefined;

            let artifactKey: string | null = null;
            let artifactTitle: string | null = null;

            if (isHeartbeat) {
              // Heartbeats are coordination — structured output is logged but doesn't need a standalone artifact
            } else if (missionId) {
              artifactKey = `mission-${missionId}`;
              artifactTitle = `${missionTitle || 'Mission'} — Latest`;
            } else if (scheduleId) {
              artifactKey = `schedule-${scheduleId}`;
              artifactTitle = `${scheduleName || 'Schedule'} — Latest`;
            }

            if (artifactKey && artifactTitle) {
              const content = formatStructuredOutput(
                structuredOutput && typeof structuredOutput === 'object' ? structuredOutput as Record<string, unknown> : undefined,
                typeof summary === 'string' ? summary : undefined
              );

              await upsertAutoArtifact({
                workerId: id,
                workspaceId: worker.workspaceId,
                key: artifactKey,
                type: structuredOutput ? 'report' : 'summary',
                title: artifactTitle,
                content: content || null,
                metadata: {
                  autoGenerated: true,
                  taskId: worker.taskId,
                  ...(structuredOutput && typeof structuredOutput === 'object' ? { structuredOutput } : {}),
                  ...(isHeartbeat && structuredOutput ? { heartbeatStatus: (structuredOutput as any)?.status } : {}),
                },
              });
            }
          }
        }

        // Notify on task completion/failure
        const taskRecord = await db.query.tasks.findFirst({
          where: eq(tasks.id, worker.taskId),
          columns: { title: true },
          with: { workspace: { columns: { name: true } } },
        });
        if (taskRecord) {
          const isDone = status === 'completed';
          if (shouldAutoRetry) {
            // Broadcast the task as available for any worker to claim
            await triggerEvent(
              channels.workspace(worker.workspaceId),
              events.TASK_ASSIGNED,
              { task: { id: worker.taskId, workspaceId: worker.workspaceId, status: 'pending' }, targetLocalUiUrl: null }
            );
            notify({
              app: 'tasks',
              title: 'Task retrying',
              message: `Auto-retrying: ${taskRecord.title}\n${taskRecord.workspace?.name || 'unknown'}`,
              url: `https://buildd.dev/app/tasks/${worker.taskId}`,
              urlTitle: 'View task',
              priority: 0,
            });
          } else {
            notify({
              app: isDone ? 'tasks' : 'alerts',
              title: isDone ? 'Task done' : 'Task failed',
              message: `${taskRecord.title}\n${taskRecord.workspace?.name || 'unknown'}`,
              url: `https://buildd.dev/app/tasks/${worker.taskId}`,
              urlTitle: 'View task',
              priority: isDone ? -1 : 0,
            });
          }
        }
      } catch (sideEffectErr) {
        console.error(`[Worker ${id}] Post-completion side effects failed:`, sideEffectErr);
      }
    }
  }

  // Capture pending instructions before clearing
  const pendingInstructions = worker.pendingInstructions;

  // Clear pending instructions on update (they'll be delivered in response)
  if (pendingInstructions) {
    updates.pendingInstructions = null;
  }

  const [updated] = await db
    .update(workers)
    .set(updates)
    .where(eq(workers.id, id))
    .returning();

  // Detect heartbeat-ok suppression: silent completion for heartbeat tasks with status "ok"
  const taskContext = worker.taskId
    ? (await db.query.tasks.findFirst({
        where: eq(tasks.id, worker.taskId),
        columns: { context: true },
      }))?.context as Record<string, unknown> | null
    : null;
  const isHeartbeatOk =
    taskContext?.heartbeat === true &&
    status === 'completed' &&
    body.structuredOutput?.status === 'ok';

  // Trigger realtime events
  const eventName = status === 'completed' ? events.WORKER_COMPLETED
    : status === 'failed' ? events.WORKER_FAILED
    : events.WORKER_PROGRESS;

  const pusherPayload: Record<string, unknown> = { worker: updated };
  if (taskProgress && Array.isArray(taskProgress) && taskProgress.length > 0) {
    pusherPayload.taskProgress = taskProgress;
  }
  if (isHeartbeatOk) {
    pusherPayload.heartbeatOk = true;
  }

  await triggerEvent(
    channels.worker(id),
    eventName,
    pusherPayload
  );

  if (worker.workspaceId) {
    await triggerEvent(
      channels.workspace(worker.workspaceId),
      eventName,
      pusherPayload
    );
  }

  // Broadcast budget-reset task back to pending (so dashboard updates)
  if (isBudgetReset && worker.taskId) {
    await triggerEvent(
      channels.workspace(worker.workspaceId),
      events.TASK_ASSIGNED,
      { task: { id: worker.taskId, workspaceId: worker.workspaceId, status: 'pending' }, targetLocalUiUrl: null }
    );
  }

  // Send Slack/Discord notifications and webhook callback on completion/failure
  // Smart suppression: skip notifications for heartbeat tasks with status "ok", auto-retried failures, or budget resets
  if ((status === 'completed' || status === 'failed') && worker.taskId && !isHeartbeatOk && !shouldAutoRetry && !isBudgetReset) {
    try {
      const taskForNotify = await db.query.tasks.findFirst({
        where: eq(tasks.id, worker.taskId),
        with: { workspace: true },
      });

      if (taskForNotify?.workspace) {
        const ws = taskForNotify.workspace;
        const result = (taskForNotify as any).result as {
          summary?: string;
          prUrl?: string;
          structuredOutput?: unknown;
        } | null;
        const summaryText = result?.summary
          ? result.summary.slice(0, 200)
          : undefined;

        const emoji = status === 'completed' ? 'white_check_mark' : 'x';
        const statusLabel = status === 'completed' ? 'completed' : 'failed';
        const lines = [
          `Task ${statusLabel}: "${taskForNotify.title}"`,
          ...(summaryText ? [`Summary: ${summaryText}`] : []),
          ...(result?.prUrl ? [`PR: ${result.prUrl}`] : []),
          `Dashboard: https://buildd.dev/app/tasks/${taskForNotify.id}`,
        ];
        const message = lines.join('\n');

        // Slack
        notifySlack(ws as any, `:${emoji}: ${message}`).catch((err) =>
          console.error('Slack notify error:', err)
        );

        // Discord
        notifyDiscord(ws as any, message, {
          title: `Task ${statusLabel}`,
          description: lines.slice(1).join('\n'),
          color: status === 'completed' ? 0x22c55e : 0xef4444,
          url: `https://buildd.dev/app/tasks/${taskForNotify.id}`,
        }).catch((err) => console.error('Discord notify error:', err));

        // Webhook callback (enriched with worker performance data)
        const completedAt = updates.completedAt ?? worker.completedAt;
        const startedAt = updates.startedAt ?? worker.startedAt;
        const durationMs = startedAt && completedAt
          ? new Date(completedAt as any).getTime() - new Date(startedAt as any).getTime()
          : null;
        sendTaskCallback(taskForNotify as any, {
          status,
          summary: result?.summary,
          prUrl: result?.prUrl,
          structuredOutput: (result as any)?.structuredOutput,
        }, {
          turns: updates.turns ?? worker.turns,
          inputTokens: updates.inputTokens ?? worker.inputTokens,
          outputTokens: updates.outputTokens ?? worker.outputTokens,
          costUsd: updates.costUsd ?? worker.costUsd,
          durationMs,
          commitCount: updates.commitCount ?? worker.commitCount,
          filesChanged: updates.filesChanged ?? worker.filesChanged,
          linesAdded: updates.linesAdded ?? worker.linesAdded,
          linesRemoved: updates.linesRemoved ?? worker.linesRemoved,
        }).catch((err) => console.error('Task callback error:', err));
      }
    } catch (err) {
      // Non-fatal — don't block the response
      console.error('Notification dispatch error:', err);
    }
  }

  // Deliver unread mission note replies/guidance to this worker
  let noteInstructions = '';
  if (status !== 'completed' && status !== 'failed' && worker.taskId) {
    try {
      const taskForNotes = await db.query.tasks.findFirst({
        where: eq(tasks.id, worker.taskId),
        columns: { missionId: true },
      });
      if (taskForNotes?.missionId) {
        // Find this worker's open questions that have replies
        const workerQuestions = await db.query.missionNotes.findMany({
          where: and(
            eq(missionNotes.missionId, taskForNotes.missionId),
            eq(missionNotes.workerId, id),
            eq(missionNotes.type, 'question'),
            eq(missionNotes.status, 'answered'),
          ),
          columns: { id: true, title: true },
        });

        if (workerQuestions.length > 0) {
          // Fetch replies to those questions
          const questionIds = workerQuestions.map(q => q.id);
          const replies = await db.query.missionNotes.findMany({
            where: and(
              eq(missionNotes.missionId, taskForNotes.missionId),
              eq(missionNotes.type, 'reply'),
              eq(missionNotes.authorType, 'user'),
              inArray(missionNotes.replyTo, questionIds),
            ),
            orderBy: [desc(missionNotes.createdAt)],
          });

          if (replies.length > 0) {
            const replyLines = replies.map(r => {
              const q = workerQuestions.find(wq => wq.id === r.replyTo);
              return `- Re: "${q?.title || 'question'}": ${r.title}${r.body ? ` — ${r.body}` : ''}`;
            });
            noteInstructions += `\n\n**USER REPLIES:**\n${replyLines.join('\n')}`;
          }
        }

        // Also deliver mission-wide guidance notes
        const guidance = await db.query.missionNotes.findMany({
          where: and(
            eq(missionNotes.missionId, taskForNotes.missionId),
            eq(missionNotes.type, 'guidance'),
            eq(missionNotes.status, 'open'),
          ),
          orderBy: [desc(missionNotes.createdAt)],
          limit: 5,
        });

        if (guidance.length > 0) {
          const guidanceLines = guidance.map(g => `- ${g.title}${g.body ? `: ${g.body}` : ''}`);
          noteInstructions += `\n\n**MISSION GUIDANCE:**\n${guidanceLines.join('\n')}`;
        }
      }
    } catch (err) {
      console.error(`[Worker ${id}] Note delivery failed:`, err);
    }
  }

  const allInstructions = [pendingInstructions, noteInstructions].filter(Boolean).join('') || undefined;

  // Return worker with any pending instructions and output warnings
  return jsonResponse({
    ...updated,
    instructions: allInstructions,
    ...(outputWarning ? { outputWarning } : {}),
  });
}

// Helper: detect budget exhaustion errors from runner error messages
function isBudgetExhaustionError(error?: string): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return lower.includes('budget limit exceeded') ||
    lower.includes('out of extra usage') ||
    lower.includes('error_max_budget_usd') ||
    lower.includes('max budget');
}

// Helper: parse a reset time like "5pm" (UTC) into a Date
function parseResetTime(timeStr: string): Date | null {
  const match = timeStr.match(/^(\d{1,2})(am|pm)?$/i);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const ampm = match[2]?.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  const now = new Date();
  const reset = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour, 0, 0, 0,
  ));
  // If the reset time is in the past today, it means tomorrow
  if (reset.getTime() <= now.getTime()) {
    reset.setUTCDate(reset.getUTCDate() + 1);
  }
  return reset;
}
