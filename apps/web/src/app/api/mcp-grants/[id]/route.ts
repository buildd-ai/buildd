import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { revokeGrant } from '@/lib/mcp-grants';
import { updateUserGrant } from '@/lib/mcp-grant-admin';
import { GRANT_NOT_FOUND, parseGrantPatch } from '@/lib/mcp-grant-patch';

export const dynamic = 'force-dynamic';

/**
 * One of the signed-in person's own MCP connections
 * (lib/mcp-grant-admin.ts, docs/specs/auth-oauth-boundaries.md "Managing
 * connections").
 *
 *   PATCH  { addWorkspaceIds?, removeWorkspaceIds?,
 *            teams?: [{ teamId, mode: 'all' } | { teamId, mode: 'specific', workspaceIds }],
 *            access?: 'read'|'read-write', actsAs?: 'agent', ifRevision? }
 *          -> { connection }
 *          409 stale_connection { connection } when ifRevision is behind;
 *          409 inherited_from_team when removing a workspace a whole-team
 *          choice still covers.
 *   DELETE -> { revoked: true }
 *
 * Dashboard session only (see ../route.ts). Someone else's connection, a
 * revoked one and an id that does not exist all answer the same 404. No
 * error repeats an id from the request. Both take effect on the app's next
 * request: every change clears the grant's cached session.
 */
type Ctx = { params: Promise<{ id: string }> };

function refuse(r: { status: number; code: string; error: string; connection?: unknown }) {
  // A stale edit gets the connection as it is now, so the page can show it.
  return NextResponse.json({ error: r.error, code: r.code, ...(r.connection ? { connection: r.connection } : {}) }, { status: r.status });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'invalid_request' }, { status: 400 });
  }
  const parsed = parseGrantPatch(body);
  if (!parsed.ok) return refuse(parsed);

  const result = await updateUserGrant(user.id, id, parsed.patch);
  if (!result.ok) return refuse(result);
  return NextResponse.json({ connection: result.connection });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const revoked = await revokeGrant(id, user.id);
  if (!revoked) return refuse(GRANT_NOT_FOUND);
  return NextResponse.json({ revoked: true });
}
