import { NextRequest, NextResponse } from 'next/server';
import { requireSessionUser } from '@/lib/auth-helpers';
import { getUserAdminTeamIds, getUserTeamIds } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { deleteTeamAgentEndpoint, listTeamAgentEndpoints, setTeamAgentEndpoint } from '@/lib/agent-endpoint-settings';

/**
 * The team's agent model endpoint (@buildd/core/agent-endpoint,
 * docs/design/agent-model-endpoint.md §6).
 *
 *   GET    → { endpoints: MaskedAgentEndpoint[] }                     any member
 *   PUT    { kind, baseUrl?, apiKey?, authHeader?, models?, agentBaseUrl?, workspaceId? }
 *          → { endpoint }                                             owner/admin; one real call first
 *   DELETE ?workspaceId= (omit for the team-wide row) → { deleted }   owner/admin
 *
 * A blank apiKey keeps the saved key, for the same kind and URL at that scope
 * only (else 400). Session only. The key never leaves the server. Verify an existing row with
 * POST /api/secrets/[id]/verify.
 */

async function caller(req: NextRequest, teamId: string, admin: boolean): Promise<Response | null> {
  const session = await requireSessionUser(req);
  if (session.response) return session.response;
  const userId = session.user.id;
  if (!(await getUserTeamIds(userId)).includes(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  if (admin && !(await getUserAdminTeamIds(userId)).includes(teamId)) {
    return NextResponse.json({ error: 'Only a team owner or admin can manage the agent endpoint.' }, { status: 403 });
  }
  return null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const denied = await caller(req, id, false);
  if (denied) return denied;
  try {
    return NextResponse.json({ endpoints: await listTeamAgentEndpoints(id) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[agent-endpoint] read failed:', error);
    return NextResponse.json({ error: 'Failed to read the agent endpoint' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const denied = await caller(req, id, true);
  if (denied) return denied;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  const { workspaceId, ...endpoint } = body;
  try {
    const r = await setTeamAgentEndpoint({ teamId: id, workspaceId, endpoint });
    return r.ok ? NextResponse.json({ endpoint: r.endpoint }) : NextResponse.json({ error: r.error }, { status: r.status });
  } catch (error) {
    console.error('[agent-endpoint] write failed:', error);
    return NextResponse.json({ error: 'Failed to save the agent endpoint' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const denied = await caller(req, id, true);
  if (denied) return denied;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (workspaceId && !isUuid(workspaceId)) return NextResponse.json({ error: 'workspaceId must be a workspace id' }, { status: 400 });
  try {
    return NextResponse.json({ deleted: await deleteTeamAgentEndpoint(id, workspaceId || null) });
  } catch (error) {
    console.error('[agent-endpoint] delete failed:', error);
    return NextResponse.json({ error: 'Failed to remove the agent endpoint' }, { status: 500 });
  }
}
