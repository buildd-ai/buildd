import { NextRequest, NextResponse } from 'next/server';
import { requireChatCaller, resolveChatTeam } from '@/lib/chat/session';
import { getChatAvailability } from '@/lib/chat-availability';

/**
 * GET /api/chat/availability?teamId= → ChatAvailabilityResponse
 *
 * Whether to show a Chat entry point at all: the same answer the pages use
 * (lib/chat-availability.ts). False when an admin switched chat off or no key
 * resolves for this person under the team's key policy.
 */
export async function GET(req: NextRequest) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const teamId = await resolveChatTeam(req, r.caller, req.nextUrl.searchParams.get('teamId'));
  if (!teamId) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  return NextResponse.json(await getChatAvailability(r.caller.user.id, teamId));
}
