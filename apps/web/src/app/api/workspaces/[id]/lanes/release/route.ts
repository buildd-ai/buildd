import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { requestingPerson } from '@/lib/request-person';
import { GATE_SLUGS, fireGateEvent } from '@/lib/gate-ledger';
import { releaseLaneHolder } from '@/lib/serial-lanes-store';
import { laneName } from '@/lib/serial-lanes';

/**
 * POST /api/workspaces/[id]/lanes/release
 *
 * A person releases a serial lane's holder (Living Spec "Overlap scheduling:
 * serial lanes and file locks", I-7, AC-9), usually one the stuck-lane report
 * named: its PR has had no activity for 24h. Body: `{ lane, taskId, reason? }`.
 * The holder's row ends `released` with who did it, its open PR stops holding
 * the lane, and position 1 may claim. Recorded on the gate ledger
 * (`serial_lane`, bypassed).
 *
 * Person-only: a dashboard session or the person's own OAuth session. An API
 * key, per-task token or agent grant is refused, so no agent frees a lane.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  if (!isUuid(workspaceId)) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const user = await getCurrentUser();
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const apiAccount = user ? null : await authenticateApiKey(apiKey, req);
  if (!user && !apiAccount) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const person = requestingPerson(user, apiAccount);
  if (!person) {
    return NextResponse.json({ error: 'Only a person can release a lane: ask the owner, or use an interactive (OAuth) session.' }, { status: 403 });
  }

  const body = await req.json().catch(() => null) as { lane?: unknown; taskId?: unknown; reason?: unknown } | null;
  const lane = typeof body?.lane === 'string' ? body.lane.trim() : '';
  const taskId = typeof body?.taskId === 'string' ? body.taskId.trim() : '';
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  if (!lane || !isUuid(taskId)) return NextResponse.json({ error: 'lane and taskId (the holder) are required' }, { status: 400 });

  const hasAccess = apiAccount
    ? await verifyAccountWorkspaceAccess(apiAccount, workspaceId)
    : await verifyWorkspaceAccess(user!.id, workspaceId);
  if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const released = await releaseLaneHolder({ workspaceId, lane, taskId, userId: person, now: new Date() });
  if (!released) return NextResponse.json({ error: `That task is not in ${laneName(lane)}` }, { status: 404 });

  fireGateEvent({
    gate: GATE_SLUGS.SERIAL_LANE,
    surface: 'POST /api/workspaces/[id]/lanes/release',
    outcome: 'bypassed',
    reason: 'lane_released',
    workspaceId,
    taskId,
    callerOrigin: user ? 'dashboard' : 'api',
    detail: { lane, holderTaskId: taskId, userId: person, reason: reason || null },
  });
  return NextResponse.json({ released: true, lane, taskId });
}
