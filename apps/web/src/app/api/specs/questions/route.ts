import { NextRequest, NextResponse } from 'next/server';
import { specCaller } from '@/lib/specs/caller';
import { openOwnerQuestions, proposeRetirementBatch } from '@/lib/specs/import-check-store';

/** GET ?workspaceId: the owner's open questions (an import's mismatch, a retirement batch). */
export async function GET(req: NextRequest) {
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const r = await openOwnerQuestions(caller, req.nextUrl.searchParams.get('workspaceId') ?? '');
  return r.ok ? NextResponse.json({ questions: r.questions }) : NextResponse.json({ error: r.error }, { status: r.status });
}

/** POST { workspaceId, items: [{ specId, reason }] }: propose retiring several specs in ONE question. Retires nothing. */
export async function POST(req: NextRequest) {
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { workspaceId?: unknown; items?: unknown } | null;
  const r = await proposeRetirementBatch(caller, { workspaceId: body?.workspaceId, items: body?.items });
  return r.ok ? NextResponse.json({ questionId: r.questionId, items: r.items }, { status: 201 }) : NextResponse.json({ error: r.error }, { status: r.status });
}
