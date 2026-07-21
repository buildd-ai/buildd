import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { startCodexDeviceAuth } from '@/lib/codex-device-auth';

type RouteContext = { params: Promise<{ id: string }> };

// POST /api/workspaces/[id]/codex-credential/device/start
// Begin the Codex device-code login. Returns the one-time code + verification URL;
// the client then polls .../device/poll until the user approves.
export async function POST(_req: NextRequest, { params }: RouteContext) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const result = await startCodexDeviceAuth();
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, deviceLoginDisabled: result.deviceLoginDisabled ?? false },
      { status: result.deviceLoginDisabled ? 409 : 502 },
    );
  }

  // device_auth_id + user_code are short-lived, single-use handles the client
  // echoes back to poll — not long-lived secrets.
  return NextResponse.json(result.value);
}
