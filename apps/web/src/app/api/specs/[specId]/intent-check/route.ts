import { NextRequest, NextResponse } from 'next/server';
import { specCaller } from '@/lib/specs/caller';
import { recordIntentCheck } from '@/lib/specs/intent-check';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * POST /api/specs/[specId]/intent-check
 *   { revision, contentHash, conversationId, messageIds, findings: [{ kind: 'mismatch'|'gap', text, recommended, criterionId? }] }
 *
 * The independent intent check's result (Living Spec 65ed7fa3 R-360 to R-362).
 * 403 for the drafter, the drafting task, any task pinned to the spec and any
 * person; empty findings is a clean check and asks the owner nothing.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const r = await recordIntentCheck(caller, specId, {
    revision: body?.revision, contentHash: body?.contentHash, conversationId: body?.conversationId, messageIds: body?.messageIds, findings: body?.findings,
  });
  if (r.ok) return NextResponse.json({ questions: r.questions });
  return NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, { status: r.status });
}
