import { NextRequest, NextResponse } from 'next/server';
import { publishSpecAnyway } from '@/lib/specs/repo-copy';
import { specCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * POST /api/specs/[specId]/publish: "Publish anyway" (Living Specs Slice 14,
 * R-68). A person who may approve specs here publishes the approved revision
 * the publication policy kept private. Recorded as an override on the decision
 * that kept it; never past a production-data hit, a missing policy or a
 * private mark.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const r = await publishSpecAnyway(caller, specId);
  if (r.ok) return NextResponse.json({ repoCopy: r.repoCopy });
  return NextResponse.json({ error: r.error }, { status: r.status });
}
