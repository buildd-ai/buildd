import { NextRequest, NextResponse } from 'next/server';
import { submitSpecRevision } from '@/lib/specs/approval';
import { specCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * POST /api/specs/[specId]/submit { expectedVersion }: a person marks the draft
 * head ready for a decision (draft to in_review). Same rights as approve.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { expectedVersion?: unknown } | null;
  const r = await submitSpecRevision(caller, specId, { expectedVersion: body?.expectedVersion });
  if (r.ok) return NextResponse.json({ spec: r.spec });
  return NextResponse.json({ error: r.error, ...(r.currentVersion !== undefined ? { currentVersion: r.currentVersion } : {}) }, { status: r.status });
}
