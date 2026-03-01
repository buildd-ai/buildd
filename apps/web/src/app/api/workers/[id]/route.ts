import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, tasks, artifacts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveCompletedTask } from '@/lib/task-dependencies';

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
  // Allow reactivation with 'running' status for follow-up messages from local-ui
  if (worker.status === 'failed' || worker.status === 'completed') {
    if (body.status !== 'running') {
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

        taskUpdate.result = {
          summary,
          branch: worker.branch,
          commits: commitCount ?? worker.commitCount ?? 0,
          sha: lastCommitSha ?? worker.lastCommitSha ?? undefined,
          files: filesChanged ?? worker.filesChanged ?? 0,
          added: linesAdded ?? worker.linesAdded ?? 0,
          removed: linesRemoved ?? worker.linesRemoved ?? 0,
          prUrl: worker.prUrl ?? undefined,
          prNumber: worker.prNumber ?? undefined,
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

      // Resolve dependencies (check if parent's children all completed)
      await resolveCompletedTask(worker.taskId, worker.workspaceId);
    }
  }

  // Enforce output requirement based on task.outputRequirement
  if (status === 'completed') {
    // Fetch task to check outputRequirement
    const task = worker.taskId
      ? await db.query.tasks.findFirst({ where: eq(tasks.id, worker.taskId) })
      : null;
    const outputReq = (task as any)?.outputRequirement ?? 'auto';

    if (outputReq !== 'none') {
      const effectiveCommits = commitCount ?? worker.commitCount ?? 0;
      const hasPR = !!worker.prUrl;

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

      // auto (default): only enforce if commits were made
      if (outputReq === 'auto' && effectiveCommits > 0 && !hasPR) {
        const workerArtifacts = await db.query.artifacts.findMany({
          where: eq(artifacts.workerId, id),
        });
        if (workerArtifacts.length === 0) {
          return NextResponse.json({
            error: `Task has ${effectiveCommits} commit(s) but no PR or artifact was created. Use create_pr to open a pull request, or create_artifact to publish your output before completing.`,
            hint: 'create_pr or create_artifact',
          }, { status: 400 });
        }
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

  await triggerEvent(
    channels.worker(id),
    eventName,
    { worker: updated }
  );

  if (worker.workspaceId) {
    await triggerEvent(
      channels.workspace(worker.workspaceId),
      eventName,
      { worker: updated }
    );
  }

  // Return worker with any pending instructions
  return NextResponse.json({
    ...updated,
    instructions: pendingInstructions || undefined,
  });
}
