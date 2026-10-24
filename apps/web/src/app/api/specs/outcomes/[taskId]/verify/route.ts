import { NextRequest, NextResponse } from 'next/server';
import { specCaller } from '@/lib/specs/caller';
import { governedTaskWorkspace } from '@/lib/specs/outcome';
import { reach } from '@/lib/specs/store';
import { isUuid } from '@/lib/uuid';
import { dispatchRegisteredVerification, resolveVerificationRequest } from '@/lib/specs/registered-verification';
import { REGISTERED_VERIFICATION } from '@/modules';

type Ctx = { params: Promise<{ taskId: string }> };

/**
 * POST /api/specs/outcomes/[taskId]/verify: run the registered `verify:` checks
 * of the task's pinned revision (or, for a mission's final verification task,
 * its mission's selection) through the same coordinator the platform uses.
 * The server resolves the head, policy, evidence and verdict; the body names at
 * most one stored capture (`evidenceRef`). Needs write access to the workspace;
 * a task token may not request grading of its own task or of the task it was filed under.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { taskId } = await params;
  const workspaceId = await governedTaskWorkspace(taskId);
  const taskScope = caller.kind === 'account'
    ? caller.account.taskScope as { taskId?: string; workspaceId: string } | undefined : undefined;
  if (!workspaceId || (taskScope && taskScope.workspaceId !== workspaceId) || !(await reach(caller, workspaceId, false))) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }
  if (!(await reach(caller, workspaceId, true))) {
    return NextResponse.json({ error: 'Requesting verification requires write access to this workspace' }, { status: 403 });
  }
  if (taskScope) {
    const refusal = taskScope.taskId ? await REGISTERED_VERIFICATION.requesterRefusal(taskScope.taskId, taskId) : 'a task token names no task';
    if (refusal) return NextResponse.json({ error: `You may not request this verification: ${refusal}` }, { status: 403 });
  }

  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => key !== 'evidenceRef')) {
    return NextResponse.json({ error: 'Only an optional evidenceRef artifact id is accepted; the server resolves head, method and evidence' }, { status: 400 });
  }
  const evidenceRef = (body as Record<string, unknown>).evidenceRef;
  if (evidenceRef !== undefined && !isUuid(evidenceRef)) {
    return NextResponse.json({ error: 'evidenceRef must be an artifact UUID' }, { status: 400 });
  }
  // The shared request contract (also what the harness plans for): a governed subject, no prompt, no self-grading.
  const request = resolveVerificationRequest({
    params: { taskId, ...(body as Record<string, unknown>) },
    caller: taskScope ? { kind: 'builder', taskId: taskScope.taskId } : { kind: 'person' },
  });
  if (!request.ok) {
    return NextResponse.json({ error: `You may not request this verification: ${request.reason}` }, { status: request.reason === 'self_grading' ? 403 : 400 });
  }
  const headSha = await REGISTERED_VERIFICATION.head(taskId);
  if (!headSha) return NextResponse.json({ error: 'The current verification head is unavailable' }, { status: 409 });
  const verification = await dispatchRegisteredVerification({ taskId, headSha, ...(evidenceRef ? { evidenceRef: evidenceRef as string } : {}) }, await REGISTERED_VERIFICATION.deps());
  return NextResponse.json({ verification });
}
