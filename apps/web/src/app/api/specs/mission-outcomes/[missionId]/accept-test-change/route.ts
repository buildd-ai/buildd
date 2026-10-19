import { NextRequest, NextResponse } from 'next/server';
import { authenticateTaskScopedCaller, taskScopeAllowsMission } from '@/lib/task-token-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { acceptTestChange } from '@/lib/specs/acceptance-test-edits-store';
import type { SpecCaller } from '@/lib/specs/store';

type Ctx = { params: Promise<{ missionId: string }> };

/**
 * POST /api/specs/mission-outcomes/[missionId]/accept-test-change { taskId, paths }:
 * a person accepts a building PR's change to acceptance tests (R-80), so those
 * tests' results count again. A task token is refused (403).
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { missionId } = await params;
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  let caller: SpecCaller;
  if (account) {
    if (!(await taskScopeAllowsMission(account, missionId))) return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    caller = { kind: 'account', account };
  } else {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    caller = { kind: 'user', userId: user.id };
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const r = await acceptTestChange(caller, missionId, { taskId: body?.taskId, paths: body?.paths });
  if (r.ok) return NextResponse.json({ remaining: r.remaining });
  return NextResponse.json({ error: r.error }, { status: r.status });
}
