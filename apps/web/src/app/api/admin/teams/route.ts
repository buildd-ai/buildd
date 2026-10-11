import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformOwner } from '@/lib/admin/owner-gate';
import { loadAdminViewer } from '@/lib/admin/scope';
import { viewTeams } from '@/lib/admin/tenant-privacy';

/**
 * GET /api/admin/teams — platform owner only (404 otherwise).
 *
 * Every team with its workspaces, so the admin app can show names where the
 * other reports carry only ids. Names for the owner's own teams (`own: true`);
 * every other team and its workspaces by pseudonym.
 */
export async function GET(req: NextRequest) {
  const gate = await requirePlatformOwner(req);
  if (gate.response) return gate.response;
  return NextResponse.json({ teams: await viewTeams(await loadAdminViewer(gate.account)) });
}
