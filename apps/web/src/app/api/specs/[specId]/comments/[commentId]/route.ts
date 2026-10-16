import { NextRequest, NextResponse } from 'next/server';
import { resolveSpecComment } from '@/lib/specs/comments';
import { specCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string; commentId: string }> };

/** PATCH /api/specs/[specId]/comments/[commentId] { resolved: true }: a person resolves a comment. An agent gets a 403. */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { specId, commentId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body?.resolved !== true) return NextResponse.json({ error: 'send { resolved: true }' }, { status: 400 });
  const r = await resolveSpecComment(caller, specId, commentId);
  return r.ok ? NextResponse.json({ resolvedAt: r.resolvedAt }) : NextResponse.json({ error: r.error }, { status: r.status });
}
