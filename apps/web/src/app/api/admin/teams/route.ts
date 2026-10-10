import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformOwner } from '@/lib/admin/owner-gate';
import { listTeamsWithWorkspaces } from '@/lib/admin/data';

/**
 * GET /api/admin/teams — platform owner only (404 otherwise).
 *
 * Every team with its workspaces, by name, so the admin app can show names
 * where the other reports carry only ids.
 */
export async function GET(req: NextRequest) {
  const gate = await requirePlatformOwner(req);
  if (gate.response) return gate.response;
  return NextResponse.json({ teams: await listTeamsWithWorkspaces() });
}
