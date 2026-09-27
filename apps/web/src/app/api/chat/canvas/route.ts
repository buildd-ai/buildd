import { NextRequest, NextResponse } from 'next/server';
import { requireChatCaller, resolveChatTeam } from '@/lib/chat/session';
import { getChatAvailability } from '@/lib/chat-availability';
import { loadTeamChatAgent } from '@/lib/chat/chat-page-data';

/**
 * GET /api/chat/canvas?teamId= → { available, agent, canManageTeamKeys }
 *
 * What the chat canvas needs when it's summoned over a page that isn't the
 * chat page (docs/design/chat-canvas.md, step 2): who the agent is and whether
 * this person can fix a missing key. Loaded once, on first open, so no page
 * pays for it until someone asks.
 */
export async function GET(req: NextRequest) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const teamId = await resolveChatTeam(req, r.caller, req.nextUrl.searchParams.get('teamId'));
  if (!teamId) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const avail = await getChatAvailability(r.caller.user.id, teamId);
  if (!avail.available) return NextResponse.json({ available: false, agent: null, canManageTeamKeys: avail.canManageTeamKeys });
  const agent = await loadTeamChatAgent(teamId);
  return NextResponse.json({ available: true, agent, canManageTeamKeys: avail.canManageTeamKeys });
}
