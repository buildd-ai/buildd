import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { consentTeamsForUser, listUserConnections } from '@/lib/mcp-grant-admin';

export const dynamic = 'force-dynamic';

/**
 * GET /api/mcp-grants: the signed-in person's own MCP connections
 * (lib/mcp-grant-admin.ts, docs/specs/auth-oauth-boundaries.md "Managing
 * connections").
 *
 *   -> { connections, legacy, teams }
 *
 * `teams` is what Settings may add to a connection: the person's teams with
 * every workspace in them, the same list the consent page offers.
 *
 * Dashboard session only. An API key, a task token or an MCP grant token is
 * never a person in the browser, so it cannot read or change connections; a
 * connection must not be able to widen itself.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const [{ connections, legacy }, teams] = await Promise.all([
    listUserConnections(user.id),
    consentTeamsForUser(user.id),
  ]);
  return NextResponse.json({ connections, legacy, teams }, { headers: { 'cache-control': 'no-store' } });
}
