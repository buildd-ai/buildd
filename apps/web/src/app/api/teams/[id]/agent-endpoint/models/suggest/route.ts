import { NextRequest, NextResponse } from 'next/server';
import { requireSessionUser } from '@/lib/auth-helpers';
import { getUserAdminTeamIds, getUserTeamIds } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { suggestEndpointModels } from '@/lib/endpoint-model-suggest';

/**
 * The decision model's suggestion for endpoint model rows nothing
 * deterministic matched (@/lib/endpoint-model-suggest).
 *
 *   POST { listed: string[], models: string[], workspaceId? }
 *        → { suggestions: [{ model, suggested, confidence }] }       owner/admin
 *
 * Suggestions only: the editor shows them flagged and saves nothing until the
 * person does. Empty when no decision model answers or none is confident.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const session = await requireSessionUser(req);
  if (session.response) return session.response;
  const userId = session.user.id;
  if (!(await getUserTeamIds(userId)).includes(id)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  if (!(await getUserAdminTeamIds(userId)).includes(id)) {
    return NextResponse.json({ error: 'Only a team owner or admin can manage the agent endpoint.' }, { status: 403 });
  }
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || !Array.isArray(body.listed) || !Array.isArray(body.models)) {
    return NextResponse.json({ error: 'listed and models must be arrays of model ids' }, { status: 400 });
  }
  const workspaceId = body.workspaceId === undefined || body.workspaceId === null || body.workspaceId === '' ? null : body.workspaceId;
  if (workspaceId !== null && (typeof workspaceId !== 'string' || !isUuid(workspaceId))) {
    return NextResponse.json({ error: 'workspaceId must be a workspace id' }, { status: 400 });
  }
  const suggestions = await suggestEndpointModels({ teamId: id, workspaceId, userId, listed: body.listed, models: body.models });
  return NextResponse.json({ suggestions }, { headers: { 'Cache-Control': 'no-store' } });
}
