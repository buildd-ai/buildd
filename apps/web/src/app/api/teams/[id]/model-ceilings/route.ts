import { NextRequest } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { handleGetCeilings, handlePutTeamCeilings } from '@/lib/model-ceilings-api';
import { ceilingsDeps } from '@/lib/model-ceilings-deps';

/**
 * GET: the team's model-tier ceilings, the caller's own layers and their
 * effective maximum per surface with a one-line explanation.
 * PUT { team?, workspaces?, overCapAuto? }: team admins.
 * Contract: docs/specs/model-tier-ceilings.md.
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: 'Team not found' }, { status: 404 });
  const ws = req.nextUrl.searchParams.get('workspaceId');
  return handleGetCeilings(id, ws && isUuid(ws) ? ws : null, ceilingsDeps(req));
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: 'Team not found' }, { status: 404 });
  const body = await req.json().catch(() => null);
  return handlePutTeamCeilings(id, body, ceilingsDeps(req));
}
