/**
 * Who is calling the Scout runner-host routes. Same credential as the other
 * runner job routes (knowledge ingest claim/complete): a runner API key,
 * never a trigger token, never a per-task token (authenticateApiKey does not
 * resolve one). The key must belong to a team; it reaches the workspaces it
 * may claim in, and the store further confines every query to its team.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { getIngestAccessibleWorkspaceIds } from '@/lib/knowledge-ingest-access';
import type { ScoutHostCaller } from '@/lib/quality-scout-runner-host';

export const NO_STORE = { 'Cache-Control': 'no-store' };

export function fail(status: number, error: string, code?: string) {
  return NextResponse.json(code ? { error, code } : { error }, { status, headers: NO_STORE });
}

export async function resolveScoutHostCaller(req: NextRequest): Promise<{ ok: true; caller: ScoutHostCaller } | { ok: false; response: NextResponse }> {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || null;
  const account = await authenticateApiKey(apiKey, req);
  if (!account) return { ok: false, response: fail(401, 'Invalid API key') };
  if (account.level === 'trigger') return { ok: false, response: fail(403, 'Trigger tokens cannot host Scout runs') };
  if (!account.teamId) return { ok: false, response: fail(403, 'This key belongs to no team') };
  const accessibleWorkspaceIds = await getIngestAccessibleWorkspaceIds(account);
  return { ok: true, caller: { accountId: account.id, teamId: account.teamId, accessibleWorkspaceIds } };
}
