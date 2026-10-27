import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateTaskScopedCaller, taskScopeAllowsMission } from '@/lib/task-token-auth';
import { isUuid } from '@/lib/uuid';
import { reach, type SpecCaller } from '@/lib/specs/store';
import { loadMission } from '@/lib/specs/mission-outcome';
import { reverifyMission } from '@/lib/specs/mission-reverify';

/**
 * POST /api/missions/[id]/verify { specId? }
 *
 * Re-verify the mission in one action: file the batched criterion check run
 * for its current integrated target and answer its task id, or answer the one
 * already queued or running (idempotent). A person or an API key with write
 * access to the workspace; a task token only for its own mission.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: `Invalid mission id: expected a UUID, got "${id}".` }, { status: 404 });
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  let caller: SpecCaller;
  if (account) {
    if (!(await taskScopeAllowsMission(account, id))) return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    caller = { kind: 'account', account };
  } else {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    caller = { kind: 'user', userId: user.id };
  }
  const mission = await loadMission(id);
  if (!mission?.workspaceId || !(await reach(caller, mission.workspaceId, false))) return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
  if (!(await reach(caller, mission.workspaceId, true))) return NextResponse.json({ error: 'Write access to the workspace is required to re-verify a mission' }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { specId?: unknown } | null;
  const r = await reverifyMission(id, typeof body?.specId === 'string' ? { specId: body.specId } : {});
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ taskId: r.taskId, headSha: r.headSha, state: r.state, filed: r.filed });
}
