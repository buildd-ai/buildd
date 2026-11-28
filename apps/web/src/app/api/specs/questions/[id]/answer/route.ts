import { NextRequest, NextResponse } from 'next/server';
import { dashboardCaller } from '@/lib/specs/caller';
import { answerOwnerQuestion } from '@/lib/specs/import-check-store';

/** POST { keep?, presence? }: the owner's one answer, from their dashboard session only. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const c = await dashboardCaller(req);
  if (!c.ok) return NextResponse.json({ error: c.error }, { status: c.status });
  const body = (await req.json().catch(() => null)) as { keep?: unknown; presence?: unknown } | null;
  const r = await answerOwnerQuestion(c.caller, (await params).id, { keep: body?.keep, presence: body?.presence });
  return r.ok ? NextResponse.json({ retired: r.retired, skipped: r.skipped }) : NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, { status: r.status });
}
