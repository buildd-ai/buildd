import { NextRequest, NextResponse } from 'next/server';
import { requireChatCaller, resolveChatTeam } from '@/lib/chat/session';
import { getChatAvailability } from '@/lib/chat-availability';

/**
 * GET /api/chat/availability?teamId= → ChatAvailabilityResponse
 *
 * Whether a chat turn can run: the same answer the pages use
 * (lib/chat-availability.ts). Chat is always on; this is false only when no
 * key resolves for this person under the team's key policy.
 */
export async function GET(req: NextRequest) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const teamId = await resolveChatTeam(req, r.caller, req.nextUrl.searchParams.get('teamId'));
  if (!teamId) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  return NextResponse.json(await getChatAvailability(r.caller.user.id, teamId));
}
