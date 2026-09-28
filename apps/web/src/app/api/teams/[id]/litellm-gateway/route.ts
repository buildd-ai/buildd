import { NextRequest, NextResponse } from 'next/server';
import { requireSessionUser } from '@/lib/auth-helpers';
import { getUserAdminTeamIds, getUserTeamIds } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { deleteTeamGateway, getTeamGateway, setTeamGateway } from '@/lib/litellm-gateway-settings';

/**
 * The team's LiteLLM gateway (@buildd/core/litellm-gateway).
 *
 *   GET    → { gateway: MaskedGateway | null }   any member
 *   PUT    { baseUrl, apiKey } → { gateway }     owner/admin; checked with the gateway first
 *   DELETE → { deleted }                         owner/admin
 *
 * Session only. The key never leaves the server.
 */

async function caller(req: NextRequest, teamId: string, admin: boolean): Promise<Response | null> {
  const session = await requireSessionUser(req);
  if (session.response) return session.response;
  const userId = session.user.id;
  if (!(await getUserTeamIds(userId)).includes(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  if (admin && !(await getUserAdminTeamIds(userId)).includes(teamId)) {
    return NextResponse.json({ error: 'Only a team owner or admin can manage the gateway.' }, { status: 403 });
  }
  return null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const denied = await caller(req, id, false);
  if (denied) return denied;
  try {
    return NextResponse.json({ gateway: await getTeamGateway(id) });
  } catch (error) {
    console.error('[litellm-gateway] read failed:', error);
    return NextResponse.json({ error: 'Failed to read the gateway' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const denied = await caller(req, id, true);
  if (denied) return denied;
  const body = await req.json().catch(() => null) as { baseUrl?: unknown; apiKey?: unknown } | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  try {
    const r = await setTeamGateway({ teamId: id, baseUrl: body.baseUrl, apiKey: body.apiKey });
    return r.ok ? NextResponse.json({ gateway: r.gateway }) : NextResponse.json({ error: r.error }, { status: r.status });
  } catch (error) {
    console.error('[litellm-gateway] write failed:', error);
    return NextResponse.json({ error: 'Failed to save the gateway' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const denied = await caller(req, id, true);
  if (denied) return denied;
  try {
    return NextResponse.json({ deleted: await deleteTeamGateway(id) });
  } catch (error) {
    console.error('[litellm-gateway] delete failed:', error);
    return NextResponse.json({ error: 'Failed to remove the gateway' }, { status: 500 });
  }
}
