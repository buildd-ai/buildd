import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';

// POST /api/workers/[id]/instruct - Send instructions to a worker (admin only)
// Instructions are delivered on the worker's next progress update
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Check for admin access via session OR admin-level API token
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  // Must have session auth OR admin-level API token
  const hasSessionAuth = !!user;
  const hasAdminToken = apiAccount?.level === 'admin';

  if (!hasSessionAuth && !hasAdminToken) {
    return NextResponse.json(
      { error: 'Unauthorized - requires session auth or admin-level API token' },
      { status: 401 }
    );
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    with: { workspace: true },
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  // Verify ownership if using session auth (not admin token)
  if (hasSessionAuth && !hasAdminToken) {
    if (worker.workspace?.ownerId !== user!.id) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }
  }

  // Can't instruct completed/failed workers
  if (worker.status === 'completed' || worker.status === 'failed') {
    return NextResponse.json(
      { error: 'Cannot instruct completed or failed workers' },
      { status: 400 }
    );
  }

  const body = await req.json();
  const { message, type = 'instruction' } = body;

  if (!message || typeof message !== 'string') {
    return NextResponse.json(
      { error: 'Message is required' },
      { status: 400 }
    );
  }

  // Get current instruction history
  const currentHistory = (worker.instructionHistory as any[]) || [];

  // Build the pending instruction payload
  let pendingPayload: string;
  if (type === 'request_plan') {
    // Structured instruction for plan request
    pendingPayload = JSON.stringify({ type: 'request_plan', message });
  } else {
    pendingPayload = message;
  }

  // Add to history and set as pending
  const newHistoryEntry = {
    type: type === 'request_plan' ? 'request_plan' as const : 'instruction' as const,
    message,
    timestamp: Date.now(),
  };

  const [updated] = await db
    .update(workers)
    .set({
      pendingInstructions: pendingPayload,
      instructionHistory: [...currentHistory, newHistoryEntry],
      updatedAt: new Date(),
    })
    .where(eq(workers.id, id))
    .returning();

  return NextResponse.json({
    ok: true,
    message: type === 'request_plan'
      ? 'Plan request queued for delivery on next worker check-in'
      : 'Instructions queued for delivery on next worker check-in',
    workerId: id,
  });
}
