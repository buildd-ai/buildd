import { NextRequest } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { handlePutOwnCeilings } from '@/lib/model-ceilings-api';
import { ceilingsDeps } from '@/lib/model-ceilings-deps';

/** PUT { ceilings }: the signed-in member's own tier maximum ({} clears). */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: 'Team not found' }, { status: 404 });
  const body = await req.json().catch(() => null);
  return handlePutOwnCeilings(id, body, ceilingsDeps(req));
}
