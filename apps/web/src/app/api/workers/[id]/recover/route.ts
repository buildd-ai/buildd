import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, tasks } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { diagnoseWorker } from '@/lib/worker-doctor';

// GET /api/workers/[id]/recover - Get recovery recommendation
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Dual auth
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!user && !account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    columns: { id: true, accountId: true, workspaceId: true },
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  // Verify access
  if (account && worker.accountId !== account.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (user) {
    const access = await verifyWorkspaceAccess(user.id, worker.workspaceId);
    if (!access) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }
  }

  const recommendation = await diagnoseWorker(id);
  return NextResponse.json(recommendation);
}

/**
 * POST /api/workers/[id]/recover
 *
 * Server-orchestrated worker recovery with three modes:
 *
 * - diagnose: Send a diagnose command to the runner, collect diagnostics
 * - complete: Force-complete a stuck worker (marks worker completed, task done)
 * - restart: Fail the current worker and reset task to pending for re-claim
 */
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

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    with: { workspace: true, task: true },
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  // Verify access
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

  const body = await req.json();
  const { mode, context } = body as { mode: string; context?: string };

  const validModes = ['diagnose', 'complete', 'restart'];
  if (!validModes.includes(mode)) {
    return NextResponse.json(
      { error: `Invalid mode. Must be one of: ${validModes.join(', ')}` },
      { status: 400 }
    );
  }

  // Terminal workers can only be restarted
  const terminalStatuses = ['completed', 'failed', 'error'];
  const isTerminal = terminalStatuses.includes(worker.status);

  if (isTerminal && mode === 'diagnose') {
    return NextResponse.json(
      { error: 'Cannot diagnose a terminal worker. Use restart to create a new attempt.' },
      { status: 400 }
    );
  }

  switch (mode) {
    case 'diagnose': {
      // Send diagnose command to runner via Pusher
      await triggerEvent(
        channels.worker(id),
        events.WORKER_COMMAND,
        { action: 'recover', recoveryMode: 'diagnose', timestamp: Date.now() }
      );

      return NextResponse.json({
        ok: true,
        mode: 'diagnose',
        message: 'Diagnosis command sent to runner. Check worker milestones for results.',
      });
    }

    case 'complete': {
      // Force-complete: update worker and task status directly
      if (!isTerminal) {
        // Send complete command to runner first (to abort gracefully)
        await triggerEvent(
          channels.worker(id),
          events.WORKER_COMMAND,
          {
            action: 'recover',
            recoveryMode: 'complete',
            recoveryContext: context,
            timestamp: Date.now(),
          }
        );
      }

      // Update worker status in DB
      await db
        .update(workers)
        .set({
          status: 'completed',
          completedAt: new Date(),
          updatedAt: new Date(),
          ...(context ? { summary: context } : {}),
        })
        .where(eq(workers.id, id));

      // Mark task as completed
      if (worker.taskId) {
        await db
          .update(tasks)
          .set({
            status: 'completed',
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, worker.taskId));
      }

      // Notify dashboard
      await triggerEvent(
        channels.workspace(worker.workspaceId),
        events.WORKER_COMPLETED,
        { workerId: id, status: 'completed' }
      );

      return NextResponse.json({
        ok: true,
        mode: 'complete',
        message: 'Worker force-completed.',
      });
    }

    case 'restart': {
      // Fail current worker, reset task for re-claim
      if (!isTerminal) {
        // Send restart command to runner (to abort and clean up)
        await triggerEvent(
          channels.worker(id),
          events.WORKER_COMMAND,
          {
            action: 'recover',
            recoveryMode: 'restart',
            recoveryContext: context,
            timestamp: Date.now(),
          }
        );
      }

      // Fail the worker in DB
      await db
        .update(workers)
        .set({
          status: 'failed',
          error: context || 'Restarted via recovery',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(workers.id, id));

      // Reset task to pending so it can be re-claimed
      if (worker.taskId) {
        // Check for other active workers on this task
        const otherActive = await db.query.workers.findMany({
          where: and(
            eq(workers.taskId, worker.taskId),
            inArray(workers.status, ['running', 'starting', 'waiting_input', 'idle']),
          ),
          columns: { id: true },
          limit: 1,
        });

        // Filter out the current worker (it may still show as active before our update propagates)
        const trulyActive = otherActive.filter(w => w.id !== id);

        if (trulyActive.length === 0) {
          await db
            .update(tasks)
            .set({
              status: 'pending',
              claimedBy: null,
              claimedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(tasks.id, worker.taskId));
        }
      }

      // Notify dashboard
      await triggerEvent(
        channels.workspace(worker.workspaceId),
        events.WORKER_FAILED,
        { workerId: id, status: 'failed' }
      );

      return NextResponse.json({
        ok: true,
        mode: 'restart',
        message: 'Worker failed. Task reset to pending for re-claim.',
        taskReset: true,
      });
    }

    default:
      return NextResponse.json({ error: 'Unknown mode' }, { status: 400 });
  }
}
