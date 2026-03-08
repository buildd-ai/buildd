import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, tasks, artifacts, workspaces, githubRepos } from '@buildd/core/db/schema';
import { githubApi } from '@/lib/github';
import { eq } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveCompletedTask } from '@/lib/task-dependencies';
import { jsonResponse } from '@/lib/api-response';
import { notify } from '@/lib/pushover';
import { notifySlack } from '@/lib/slack-notify';
import { notifyDiscord } from '@/lib/discord-notify';
import { sendTaskCallback } from '@/lib/task-callback';

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
  if (worker.status === 'failed' || worker.status === 'completed') {
    const isCleanupExpiry = worker.error?.includes('expired') ||
      worker.error?.includes('timed out') ||
      worker.error?.includes('went offline') ||
      worker.error?.includes('runner restarted');
    if (body.status !== 'running' || isCleanupExpiry) {
      return NextResponse.json({
        error: worker.status === 'failed'
          ? 'Worker was terminated - task may have been reassigned'
          : 'Worker already completed',
        abort: true,
        reason: worker.error || worker.status,
      }, { status: 409 });
    }
    // Reactivation: clear completion timestamp so worker can run again
  }
  const {
    status, error, costUsd, turns, localUiUrl, currentAction, milestones,
    appendMilestones,
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
  if (localUiUrl !== undefined) updates.localUiUrl = localUiUrl;
  if (currentAction !== undefined) updates.currentAction = currentAction;
  if (milestones !== undefined) updates.milestones = milestones;
  // appendMilestones: merge new milestones into existing (for MCP workers)
  if (appendMilestones && Array.isArray(appendMilestones)) {
    const existing = (worker.milestones as any[]) || [];
    const merged = [...existing, ...appendMilestones];
    updates.milestones = merged.length > 50 ? merged.slice(-50) : merged;
  }
  // Git stats
  if (lastCommitSha !== undefined) updates.lastCommitSha = lastCommitSha;
  if (typeof commitCount === 'number') updates.commitCount = commitCount;
  if (typeof filesChanged === 'number') updates.filesChanged = filesChanged;
  if (typeof linesAdded === 'number') updates.linesAdded = linesAdded;
  if (typeof linesRemoved === 'number') updates.linesRemoved = linesRemoved;
  // Waiting state
  if (waitingFor !== undefined) updates.waitingFor = waitingFor;
  // Auto-clear waitingFor when worker resumes running
  if (status === 'running' && waitingFor === undefined) updates.waitingFor = null;
  // SDK result metadata
  if (resultMeta !== undefined) updates.resultMeta = resultMeta;

  // Handle status transitions
  if (status === 'running' && !worker.startedAt) {
    updates.startedAt = new Date();
  }
  // Reactivation: clear completion state when worker resumes from completed/failed
  if (status === 'running' && (worker.status === 'completed' || worker.status === 'failed')) {
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

  if (status === 'completed' || status === 'failed') {
    updates.completedAt = new Date();

    // Update task status + snapshot deliverables
    if (worker.taskId) {
      const taskUpdate: Record<string, unknown> = {
        status: status === 'completed' ? 'completed' : 'failed',
        updatedAt: new Date(),
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
        };
      }

      await db
        .update(tasks)
        .set(taskUpdate)
        .where(eq(tasks.id, worker.taskId));

      // Post-completion side effects (non-fatal — must not block worker update)
      try {
        // Resolve dependencies (check if parent's children all completed)
        await resolveCompletedTask(worker.taskId, worker.workspaceId);

        // Notify on task completion/failure
        const taskRecord = await db.query.tasks.findFirst({
          where: eq(tasks.id, worker.taskId),
          columns: { title: true },
          with: { workspace: { columns: { name: true } } },
        });
        if (taskRecord) {
          const isDone = status === 'completed';
          notify({
            app: isDone ? 'tasks' : 'alerts',
            title: isDone ? 'Task done' : 'Task failed',
            message: `${taskRecord.title}\n${taskRecord.workspace?.name || 'unknown'}`,
            url: `https://app.buildd.dev/app/tasks/${worker.taskId}`,
            urlTitle: 'View task',
            priority: isDone ? -1 : 0,
          });
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

  // Trigger realtime events
  const eventName = status === 'completed' ? events.WORKER_COMPLETED
    : status === 'failed' ? events.WORKER_FAILED
    : events.WORKER_PROGRESS;

  const pusherPayload: Record<string, unknown> = { worker: updated };
  if (taskProgress && Array.isArray(taskProgress) && taskProgress.length > 0) {
    pusherPayload.taskProgress = taskProgress;
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

  // Send Slack/Discord notifications and webhook callback on completion/failure
  if ((status === 'completed' || status === 'failed') && worker.taskId) {
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

        // Webhook callback
        sendTaskCallback(taskForNotify as any, {
          status,
          summary: result?.summary,
          prUrl: result?.prUrl,
          structuredOutput: (result as any)?.structuredOutput,
        }).catch((err) => console.error('Task callback error:', err));
      }
    } catch (err) {
      // Non-fatal — don't block the response
      console.error('Notification dispatch error:', err);
    }
  }

  // Return worker with any pending instructions and output warnings
  return jsonResponse({
    ...updated,
    instructions: pendingInstructions || undefined,
    ...(outputWarning ? { outputWarning } : {}),
  });
}
