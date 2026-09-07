import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, tasks } from '@buildd/core/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess } from '@/lib/team-access';

// POST /api/workers/[id]/respond - Respond to a worker's question, creating a retry task
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Dual auth: session OR API key
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!user && !account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Load worker with its task
  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    with: { workspace: true, task: true },
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  // Verify access: API key checks account ownership, session checks workspace membership
  if (account) {
    if (worker.accountId !== account.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  } else if (user) {
    const access = await verifyWorkspaceAccess(user.id, worker.workspaceId);
    if (!access) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }
  }

  // Worker must have waitingFor set (status failed with needs_input or waiting_input)
  if (!worker.waitingFor) {
    return NextResponse.json(
      { error: 'Worker is not waiting for input' },
      { status: 400 }
    );
  }

  const body = await req.json();
  const { message } = body;

  if (!message || typeof message !== 'string') {
    return NextResponse.json(
      { error: 'Message is required' },
      { status: 400 }
    );
  }

  const task = (worker as any).task;
  // Sensitive-dataClass workspaces strip milestone labels, leaving { type, ts }.
  const milestones = (worker.milestones as Array<{ type?: string; label?: string; timestamp: number }>) || [];
  const question = (worker.waitingFor as { prompt: string }).prompt;
  const taskContext = (task?.context as Record<string, unknown>) || {};
  const currentIteration = (taskContext.iteration as number) || 1;

  // Build structured description
  const milestonesText = milestones.length > 0
    ? milestones.map(m => `- ${m.label || m.type || 'activity'}`).join('\n')
    : 'No milestones recorded';

  const description = [
    '## Original Task',
    task?.description || '',
    '',
    '## What Was Accomplished',
    milestonesText,
    '',
    '## Question Asked',
    question,
    '',
    '## User Response',
    message,
  ].join('\n');

  // Claim the answer FIRST, atomically. `worker.waitingFor` was read outside the
  // write, so two humans answering the same question (or one double-submitting)
  // both passed the guard above: both inserted a "Continue:" retry task and both
  // wrote the worker row. Gate the state flip on the question still being open —
  // only the winner may create a task. Claiming before inserting also means a
  // loser leaves nothing behind, instead of an orphan retry task.
  //
  // Status is 'superseded', not 'completed': this worker did not finish its
  // task, it was replaced by the continuation task inserted below. Recording it
  // as 'completed' would count an answered question as a clean success in
  // get_failure_analytics / success-rate-by-role — neither true nor the
  // opposite (a genuine failure). 'superseded' is excluded from both buckets
  // (see IN_FLIGHT_WORKER_STATUSES in lib/failure-analytics.ts) and is included
  // in TERMINAL_WORKER_STATUSES (workers/[id]/route.ts) so a later PATCH from
  // the runner for this same worker is rejected instead of resurrecting it.
  //
  // Known residual race, deliberately not closed here: this write and an
  // in-flight runner PATCH for the same worker use independent, uncoordinated
  // CAS predicates (this one gates on waitingFor being set; the PATCH route's
  // terminal-transition reservation gates on status). If the runner's PATCH has
  // already read the pre-answer row and is mid-flight when this commits, its
  // own later write can still land after this one and overwrite `status`. A
  // worker read AFTER this commits is correctly rejected (terminal-status
  // guard), so the window is narrow — but fully closing it needs a shared
  // reservation primitive between the two routes, not a stronger predicate
  // here: gating this claim on worker status (rather than only waitingFor)
  // would break the deliberate, tested contract that an AskUserQuestion abort
  // can legitimately leave status='error'/'failed' with waitingFor still set.
  const [claimed] = await db
    .update(workers)
    .set({
      status: 'superseded',
      waitingFor: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(workers.id, id), isNotNull(workers.waitingFor)))
    .returning();

  if (!claimed) {
    return NextResponse.json(
      { error: 'Question was already answered' },
      { status: 409 },
    );
  }

  // Create the new retry task.
  //
  // Field-by-field decision on what carries over from the original task —
  // deliberate per field, not a blanket copy:
  //
  //  - mode, taskClass: COPY. The continuation's job is the ORIGINAL task's
  //    job, now armed with an answer — not a new kind of task. When mode was
  //    'planning' (the parent's deliverable IS a structured plan, e.g. a
  //    mission organizer cycle that asked a clarifying question mid-decompose),
  //    the continuation still owes that same plan; the SDK's outputFormat
  //    constraint (resolveOutputFormat, keyed on mode) applies identically to
  //    it, and the planning-contract guard's mode==='planning' clause
  //    (workers/[id]/route.ts) fires the same way regardless of scheduleId or
  //    creationSource — those only gate the guard's separate orchestrator-
  //    fallback clause, which this route's continuations never hit since
  //    creationSource here always defaults to 'api' (see below).
  //  - priority, outputRequirement, outputSchema, category, pathManifest,
  //    backend: COPY. None of these describe *how* the task was created —
  //    they describe what it must deliver and how, which does not change
  //    because a question was asked. Dropping outputSchema in particular used
  //    to silently swap a custom contract (e.g. a reviewer verdict schema) for
  //    either the default planning schema or no schema at all. Dropping
  //    priority sent a priority-9 task's continuation to the back of the
  //    queue. Dropping pathManifest lost the conflict-serialization edges
  //    against sibling tasks touching the same files.
  //  - dependsOn: NOT copied. Those edges gated the ORIGINAL task's claim on
  //    prerequisites that were already satisfied before it could run in the
  //    first place — the continuation isn't blocked on them again.
  //  - subjectAnchor: NOT copied. It drives the subject-dedup/supersession
  //    gate for auto-filed tasks (friction/webhook/CI-retry); copying it onto
  //    a new task id under a human-answered flow isn't a case that subsystem
  //    is designed for.
  //  - creationSource: NOT copied (defaults to 'api'). It records who/what
  //    created the row; this row was created by a human or API caller
  //    answering a question via this route, which 'api' describes accurately.
  let newTask;
  try {
    [newTask] = await db
      .insert(tasks)
      .values({
        workspaceId: worker.workspaceId,
        title: `Continue: ${task?.title || 'Unknown task'}`,
        description,
        status: 'pending',
        parentTaskId: task?.id,
        missionId: task?.missionId,
        roleSlug: task?.roleSlug,
        mode: task?.mode,
        taskClass: (task?.taskClass ?? 'work') as 'work' | 'attempt' | 'bookkeeping',
        priority: task?.priority,
        outputRequirement: task?.outputRequirement,
        outputSchema: task?.outputSchema,
        category: task?.category,
        pathManifest: task?.pathManifest,
        backend: task?.backend,
        context: {
          // Honored by the runner's setupWorktree/resolveWorktreeBase — but
          // only when `worker.branch` already exists on the remote (verified
          // by fetching and probing `origin/<branch>`). If the original
          // worker was blocked before ever pushing (the common case: a
          // question asked mid-task, before create_pr), no such branch
          // exists, and the runner silently falls back to a fresh worktree
          // from the default branch — the "resumes the existing worktree"
          // claim this route's callers make does NOT hold in that case, and
          // nothing here can verify at request time which case applies.
          baseBranch: worker.branch,
          // Explicit continuity marker (same value; this is what the runner's
          // resumeCandidate logic actually keys resume-vs-cut-from-base on —
          // baseBranch alone is ambiguous with a mission-branch task's declared
          // base, which must never be checked out directly).
          resumeBranch: worker.branch,
          userInput: message,
          previousAttempt: {
            question,
            milestones,
            branch: worker.branch,
            workerId: worker.id,
          },
          iteration: currentIteration + 1,
        },
      })
      .returning();
  } catch (err) {
    // No transactions on neon-http: compensate by hand so a failed insert does
    // not leave the worker completed with the question gone and no retry task.
    console.error(`[Worker ${id}] Retry task insert failed, restoring question:`, err);
    await db
      .update(workers)
      .set({
        status: worker.status,
        waitingFor: worker.waitingFor,
        completedAt: worker.completedAt ?? null,
        updatedAt: new Date(),
      })
      .where(eq(workers.id, id));
    return NextResponse.json(
      { error: 'Failed to record response' },
      { status: 500 },
    );
  }

  return NextResponse.json({ taskId: newTask.id });
}
