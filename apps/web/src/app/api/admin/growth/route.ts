import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformOwner } from '@/lib/admin/owner-gate';
import { loadGrowth } from '@/lib/admin/growth';

/**
 * GET /api/admin/growth — platform owner only (404 otherwise).
 *
 * People, not workspaces: total accounts, signups and daily active people per
 * UTC day for the last 90 days, WAU, MAU and DAU/MAU, split by dashboard vs
 * MCP. Counts only, never who. Activity is counted from `activeSince`.
 */
export async function GET(req: NextRequest) {
  const gate = await requirePlatformOwner(req);
  if (gate.response) return gate.response;
  return NextResponse.json(await loadGrowth());
}
