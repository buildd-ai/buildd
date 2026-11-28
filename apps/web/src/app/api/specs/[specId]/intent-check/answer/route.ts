import { NextRequest, NextResponse } from 'next/server';
import { specCaller } from '@/lib/specs/caller';
import { answerIntentQuestion } from '@/lib/specs/intent-check';

type Ctx = { params: Promise<{ specId: string }> };

/** POST { revision, questionId, answer? }: the owner answers (or accepts the suggested answer to) one intent question. A person's session only. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const r = await answerIntentQuestion(caller, specId, { revision: body?.revision, questionId: body?.questionId, answer: body?.answer });
  if (r.ok) return NextResponse.json({ question: r.question });
  return NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, { status: r.status });
}
