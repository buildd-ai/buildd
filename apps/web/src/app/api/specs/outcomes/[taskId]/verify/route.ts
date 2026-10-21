import { NextRequest, NextResponse } from 'next/server';
import { specCaller } from '@/lib/specs/caller';
import { governedTaskWorkspace } from '@/lib/specs/outcome';
import { reach } from '@/lib/specs/store';
import { isUuid } from '@/lib/uuid';
import { dispatchRegisteredVerification } from '@/lib/specs/registered-verification';
import { registeredVerificationHead } from '@/lib/specs/registered-verification-store';

type Ctx = { params: Promise<{ taskId: string }> };

/** Request registered checks; the server resolves their policy, target and evidence. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { taskId } = await params;
  const workspaceId = await governedTaskWorkspace(taskId);
  const taskScope = caller.kind === 'account'
    ? caller.account.taskScope as { taskId?: string; workspaceId: string } | undefined : undefined;
  if (!workspaceId || (taskScope && (taskScope.taskId !== taskId || taskScope.workspaceId !== workspaceId))
    || !(await reach(caller, workspaceId, false))) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  if (!(await reach(caller, workspaceId, true))) {
    return NextResponse.json({ error: 'Requesting verification requires write access to this workspace' }, { status: 403 });
  }

  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => key !== 'evidenceRef')) {
    return NextResponse.json({ error: 'Only an optional evidenceRef artifact id is accepted' }, { status: 400 });
  }
  const evidenceRef = (body as Record<string, unknown>).evidenceRef;
  if (evidenceRef !== undefined && !isUuid(evidenceRef)) {
    return NextResponse.json({ error: 'evidenceRef must be an artifact UUID' }, { status: 400 });
  }
  const headSha = await registeredVerificationHead(taskId);
  if (!headSha) return NextResponse.json({ error: 'The current verification head is unavailable' }, { status: 409 });
  const verification = await dispatchRegisteredVerification({ taskId, headSha, ...(evidenceRef ? { evidenceRef } : {}) });
  return NextResponse.json({ verification });
}
