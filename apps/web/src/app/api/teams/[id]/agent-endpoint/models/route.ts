import { NextRequest, NextResponse } from 'next/server';
import { requireSessionUser } from '@/lib/auth-helpers';
import { getUserAdminTeamIds, getUserTeamIds } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { previewAgentEndpointModels } from '@/lib/agent-endpoint-settings';

/**
 * What an agent model endpoint serves, for the settings editor's model
 * mapping (docs/design/agent-model-endpoint.md §4).
 *
 *   POST { kind, baseUrl?, apiKey?, authHeader?, models?, workspaceId? }
 *        → { available, listed: string[], rows }                     owner/admin
 *
 * The server calls the endpoint's `/v1/models` (public hosts only, no
 * redirects, bounded). Omit `apiKey` to use the key stored for the same
 * endpoint at that scope. Session only; the reply is model ids, never the key
 * or the endpoint's reply. Nothing is stored. Suggestions for unmatched rows:
 * POST ./suggest.
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
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  const { workspaceId, ...endpoint } = body;
  try {
    const r = await previewAgentEndpointModels({ teamId: id, workspaceId, endpoint });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ available: r.available, listed: r.listed, rows: r.rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[agent-endpoint] model list failed:', error instanceof Error ? error.name : 'error');
    return NextResponse.json({ error: 'Failed to list the endpoint\'s models' }, { status: 500 });
  }
}
