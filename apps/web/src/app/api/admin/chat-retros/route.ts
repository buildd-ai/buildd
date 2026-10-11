import { NextRequest, NextResponse } from 'next/server';
import { beginAdminRead, intParam } from '@/lib/admin/scope';
import { listChatRetros } from '@/lib/admin/data';

/**
 * GET /api/admin/chat-retros — platform owner only (404 otherwise).
 *
 * Chat session retros across teams, newest first: labels and counts, never
 * message text. Query: window, teamId?, limit (default 100, max 500).
 */
export async function GET(req: NextRequest) {
  const read = await beginAdminRead(req);
  if ('response' in read) return read.response;
  const limit = intParam(read.params, 'limit', 100, 500);
  const retros = await listChatRetros({ teamId: read.scope.teamId, since: read.scope.since, limit });
  return NextResponse.json({ ...read.scope, since: read.scope.since.toISOString(), limit, retros });
}
