import { NextRequest, NextResponse } from 'next/server';
import { approveFromConversation } from '@/lib/specs/approval';
import { dashboardCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * POST /api/specs/[specId]/approve/conversation
 *   { revision, expectedVersion, conversationId, messageId, criterionSources?, retire?, overrideReason?, presence? }
 *
 * Approval by recorded intent (Living Spec 65ed7fa3, D-18): the owner's own
 * signed-in session cites the message in which they approved. Any request
 * carrying an Authorization header (agent, task or API token, the drafter
 * included) is a 403 before the body is read; a message the caller did not
 * write, in a conversation they do not own, is a 403; a revision that is no
 * longer the head at that version is a 409. Recorded as `conversation`.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const c = await dashboardCaller(req);
  if (!c.ok) return NextResponse.json({ error: c.error }, { status: c.status });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const r = await approveFromConversation(c.caller, specId, {
    revision: body?.revision, expectedVersion: body?.expectedVersion, conversationId: body?.conversationId, messageId: body?.messageId,
    criterionSources: body?.criterionSources, overrideReason: body?.overrideReason, retire: body?.retire, presence: body?.presence,
  });
  if (r.ok) return NextResponse.json({ spec: r.spec, revision: r.revision, already: r.already, retirements: r.retirements });
  return NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.gate ? { gate: r.gate } : {}), ...(r.currentVersion !== undefined ? { currentVersion: r.currentVersion } : {}), ...(r.presence ? { presence: r.presence } : {}) }, { status: r.status });
}
