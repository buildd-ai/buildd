import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformOwner } from '@/lib/admin/owner-gate';
import { ADMIN_WINDOWS, type AdminWindow } from '@/lib/admin/scope';
import { loadEmbeddingUsage } from '@/lib/admin/embedding-usage';

/**
 * GET /api/admin/embedding-usage — platform owner only (404 otherwise).
 *
 * Voyage tokens by UTC day, team, model, corpus and caller, with an estimated
 * cost and this month's budgets. Read-only. Query: window=24h|7d|30d (default 7d).
 */
export async function GET(req: NextRequest) {
  const gate = await requirePlatformOwner(req);
  if (gate.response) return gate.response;
  const window = req.nextUrl.searchParams.get('window') ?? '7d';
  if (!(window in ADMIN_WINDOWS)) {
    return NextResponse.json({ error: `window must be one of ${Object.keys(ADMIN_WINDOWS).join(', ')}` }, { status: 400 });
  }
  return NextResponse.json(await loadEmbeddingUsage(window as AdminWindow));
}
