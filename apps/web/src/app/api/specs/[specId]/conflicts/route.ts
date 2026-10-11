import { NextRequest, NextResponse } from 'next/server';
import { recordSpecConflict } from '@/lib/specs/outcome';
import { specCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * POST /api/specs/[specId]/conflicts { revision, criterionIds: [a, b], note? }:
 * flag two criteria of an approved revision as conflicting. Advisory: an open
 * `conflict` discrepancy for a person to accept, never a block.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const r = await recordSpecConflict(caller, specId, { revision: body?.revision, criterionIds: body?.criterionIds, note: body?.note });
  if (r.ok) return NextResponse.json({ discrepancyId: r.discrepancyId });
  return NextResponse.json({ error: r.error }, { status: r.status });
}
