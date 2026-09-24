import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers, workerErrorTraces } from '@buildd/core/db/schema';
import { eq, desc, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { isGateSatisfied } from '@/lib/task-presentation';
import { deriveTaskOrigin } from '@/lib/task-origin';

/** One record the task produced, as the sheet lists it (W4 "Records"). */
export interface TaskSummaryRecord {
  id: string;
  type: string;
  title: string | null;
  href: string;
}

// GET /api/tasks/[id]/summary — lightweight task data for the slide-over panel
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, id),
      columns: {
        id: true,
        title: true,
        status: true,
        description: true,
        mode: true,
        roleSlug: true,
        createdAt: true,
        missionId: true,
        workspaceId: true,
        result: true,
        backend: true,
        context: true,
        dependsOn: true,
        // Provenance (U6) — the columns deriveTaskOrigin reads.
        creationSource: true,
        createdByWorkerId: true,
        createdByAccountId: true,
        scheduleId: true,
        parentTaskId: true,
        ciRetryPrNumber: true,
        reviewerRetryPrNumber: true,
        conflictRetryPrNumber: true,
        taskClass: true,
      },
      with: {
        mission: { columns: { title: true } },
        parentTask: { columns: { title: true } },
        creatorAccount: { columns: { name: true } },
        creatorWorker: {
          columns: { name: true },
          with: { task: { columns: { id: true, roleSlug: true } } },
        },
        schedule: { columns: { name: true } },
      },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
    if (!access) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Get latest worker
    const latestWorkers = await db.query.workers.findMany({
      where: eq(workers.taskId, id),
      orderBy: desc(workers.createdAt),
      limit: 1,
      columns: {
        id: true,
        status: true,
        currentAction: true,
        turns: true,
        prUrl: true,
        prNumber: true,
        prLifecycleStatus: true,
        mergedAt: true,
        commitCount: true,
        filesChanged: true,
        linesAdded: true,
        linesRemoved: true,
        costUsd: true,
        inputTokens: true,
        outputTokens: true,
        startedAt: true,
        completedAt: true,
        waitingFor: true,
        branch: true,
        milestones: true,
      },
      with: {
        account: {
          columns: { authType: true },
        },
      },
    });

    const worker = latestWorkers[0] || null;
    const result = task.result as { summary?: string; nextSuggestion?: string } | null;

    // Failover metadata lives on task.context (stamped when a Claude task is
    // flipped to Codex on budget exhaustion). Surface just the display bits so
    // the panel can show "ran on Codex after Claude budget hit".
    const ctx = task.context as {
      failedOverFrom?: string;
      failoverReason?: string;
      budgetExhausted?: boolean;
    } | null;
    const failover = ctx?.failedOverFrom
      ? { from: ctx.failedOverFrom, reason: ctx.failoverReason ?? null }
      : null;

    // Latest error excerpt across all workers on this task — powers the panel's
    // "Failed" state so you see *why* it broke without opening the full page.
    const latestTraces = await db.query.workerErrorTraces.findMany({
      where: eq(workerErrorTraces.taskId, id),
      orderBy: desc(workerErrorTraces.ts),
      limit: 1,
      columns: { excerpt: true, pattern: true, ts: true },
    });
    const trace = latestTraces[0] || null;

    // Records (W4): what the task produced, across every attempt's worker.
    // Titles only — never `content`, which can be large.
    const recordWorkers = await db.query.workers.findMany({
      where: eq(workers.taskId, id),
      orderBy: desc(workers.createdAt),
      columns: { id: true },
      with: { artifacts: { columns: { id: true, type: true, title: true } } },
    });
    const records: TaskSummaryRecord[] = (recordWorkers ?? [])
      .flatMap(w => (w as { artifacts?: Array<{ id: string; type: string; title: string | null }> }).artifacts ?? [])
      .filter(a => a.type !== 'impl_plan')
      .map(a => ({ id: a.id, type: a.type, title: a.title ?? null, href: `/app/artifacts/${a.id}` }));

    // Origin (U6): who created the task and why, from stored columns only —
    // the same derivation as the task page. "You" is claimed only on a name
    // match with the viewer, as there.
    const viewerNames = [user.name, user.email, user.email?.split('@')[0]]
      .filter((n): n is string => !!n)
      .map(n => n.toLowerCase());
    const creatorAccountName = task.creatorAccount?.name ?? null;
    const derivedOrigin = deriveTaskOrigin(task as Parameters<typeof deriveTaskOrigin>[0], {
      actorName: creatorAccountName ?? task.creatorWorker?.name ?? null,
      isSelf: !!creatorAccountName && viewerNames.includes(creatorAccountName.toLowerCase()),
      creatorRoleSlug: task.creatorWorker?.task?.roleSlug ?? null,
      creatorWorkerTaskId: task.creatorWorker?.task?.id ?? null,
      scheduleName: task.schedule?.name ?? null,
      missionTitle: task.mission?.title ?? null,
      parentTaskTitle: task.parentTask?.title ?? null,
    });
    const origin = derivedOrigin.isEmpty
      ? null
      : { actor: derivedOrigin.actor, parts: derivedOrigin.parts, links: derivedOrigin.links };

    // Count unresolved dependencies via the SHARED gate predicate.
    // This used to hand-roll the rule and said it "mirrors the gate used on the
    // task detail page" — which was itself a local copy, so it inherited that
    // copy's bug: `d.status !== 'completed'` treats a CANCELLED dep as
    // blocking, while the gate treats cancelling as a deliberate "this won't be
    // delivered" signal that releases dependents. Any consumer of this endpoint
    // was told a claimable task was blocked. It also guarded on `prNumber`
    // where the contract guards on `prUrl`.
    // Only checked for pending tasks; non-pending tasks are already past the gate.
    const depTaskIds = (task.dependsOn as string[] | undefined) || [];
    let blockedByCount = 0;
    if (task.status === 'pending' && depTaskIds.length > 0) {
      const depTasks = await db.query.tasks.findMany({
        where: inArray(tasks.id, depTaskIds),
        columns: { id: true, status: true },
        with: {
          workers: {
            columns: { prUrl: true, prNumber: true, mergedAt: true, prLifecycleStatus: true },
            orderBy: desc(workers.createdAt),
            limit: 1,
          },
        },
      });
      blockedByCount = depTasks.filter(
        d => !isGateSatisfied(d, (d.workers ?? []) as Parameters<typeof isGateSatisfied>[1]),
      ).length;
    }

    return NextResponse.json({
      id: task.id,
      title: task.title,
      status: worker?.status === 'waiting_input' && !['completed', 'failed'].includes(task.status)
        ? 'waiting_input'
        : task.status,
      description: task.description,
      mode: task.mode,
      roleSlug: task.roleSlug,
      createdAt: task.createdAt,
      missionId: task.missionId,
      backend: task.backend,
      failover,
      worker: worker
        ? {
            id: worker.id,
            status: worker.status,
            currentAction: worker.currentAction,
            turns: worker.turns,
            prUrl: worker.prUrl,
            prNumber: worker.prNumber,
            prLifecycleStatus: worker.prLifecycleStatus,
            mergedAt: worker.mergedAt,
            commitCount: worker.commitCount,
            filesChanged: worker.filesChanged,
            linesAdded: worker.linesAdded,
            linesRemoved: worker.linesRemoved,
            costUsd: worker.costUsd,
            inputTokens: worker.inputTokens,
            outputTokens: worker.outputTokens,
            startedAt: worker.startedAt,
            completedAt: worker.completedAt,
            waitingFor: worker.waitingFor as { type: string; prompt: string; options?: string[] } | null,
            branch: worker.branch,
            milestones: worker.milestones ?? [],
            account: worker.account
              ? { authType: worker.account.authType }
              : null,
          }
        : null,
      lastError: trace
        ? { excerpt: trace.excerpt, pattern: trace.pattern, ts: trace.ts }
        : null,
      result: result
        ? {
            summary: result.summary || null,
            nextSuggestion: result.nextSuggestion || null,
          }
        : null,
      blockedByCount,
      records,
      origin,
    });
  } catch (error) {
    console.error('Task summary error:', error);
    return NextResponse.json({ error: 'Failed to get task summary' }, { status: 500 });
  }
}
