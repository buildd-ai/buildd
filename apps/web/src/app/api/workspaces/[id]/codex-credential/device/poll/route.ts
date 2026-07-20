import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { pollCodexDeviceAuth } from '@/lib/codex-device-auth';
import { storeCodexCredential, getCodexStatus, type CodexScope } from '@/lib/codex-credential';
import { requeueAuthFailedTasks } from '@/lib/credential-recovery';

type RouteContext = { params: Promise<{ id: string }> };

function buildScope(teamId: string, workspaceId: string, scopeParam: string | null): CodexScope {
  return scopeParam === 'workspace' ? { teamId, workspaceId } : { teamId };
}

// POST /api/workspaces/[id]/codex-credential/device/poll
// Body: { deviceAuthId, userCode, scope?: 'team' | 'workspace' }
// Polls OpenAI once. Returns { status: 'pending' } until the user approves; on
// approval, exchanges the code, stores the buildd-owned Codex credential, requeues
// auth-failed tasks, and returns { status: 'connected', ...codexStatus }.
export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const { deviceAuthId, userCode, scope: scopeParam } = body as { deviceAuthId?: string; userCode?: string; scope?: string };
  if (!deviceAuthId || !userCode) {
    return NextResponse.json({ error: 'deviceAuthId and userCode are required' }, { status: 400 });
  }

  const result = await pollCodexDeviceAuth(deviceAuthId, userCode);

  if (result.status === 'pending') return NextResponse.json({ status: 'pending' });
  if (result.status === 'error') return NextResponse.json({ status: 'error', error: result.error }, { status: 502 });

  // Authorized — store the buildd-owned credential and recover stranded tasks.
  const scope = buildScope(access.teamId, id, typeof scopeParam === 'string' ? scopeParam : null);
  await storeCodexCredential(scope, result.authJson);
  try {
    await requeueAuthFailedTasks(access.teamId);
  } catch (err) {
    console.warn('[codex-device] requeue-on-recovery failed (non-fatal):', err);
  }
  const status = await getCodexStatus(scope);
  return NextResponse.json({ status: 'connected', ...status });
}
