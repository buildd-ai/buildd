import { NextRequest } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { handlePutMemberCeilings } from '@/lib/model-ceilings-api';
import { ceilingsDeps } from '@/lib/model-ceilings-deps';

/** PUT { ceilings }: a team admin sets a member's tier maximum, which the member cannot lift ({} clears). */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; userId: string }> }) {
  const { id, userId } = await params;
  if (!isUuid(id) || !isUuid(userId)) return Response.json({ error: 'Not found' }, { status: 404 });
  const body = await req.json().catch(() => null);
  return handlePutMemberCeilings(id, userId, body, ceilingsDeps(req));
}
