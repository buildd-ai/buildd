import { NextRequest, NextResponse } from 'next/server';
import { getUserTeamRole } from '@/lib/team-access';
import { chatAvailability, requireChatCaller, resolveChatTeam } from '@/lib/chat/session';

/**
 * GET /api/chat/availability?teamId= → ChatAvailabilityResponse
 *
 * Whether to show a Chat entry point at all. False when the team hasn't turned
 * the `chat` capability on, or when no provider key resolves — in both cases
 * nothing in the app changes.
 */
export async function GET(req: NextRequest) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const teamId = await resolveChatTeam(req, r.caller, req.nextUrl.searchParams.get('teamId'));
  if (!teamId) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const role = await getUserTeamRole(r.caller.user.id, teamId);
  return NextResponse.json(await chatAvailability(teamId, r.caller.user.id, role));
}
