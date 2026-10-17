import { NextRequest, NextResponse } from 'next/server';
import { specCaller } from '@/lib/specs/caller';
import { specCriterionHistory } from '@/lib/specs/revision-changes';

type Ctx = { params: Promise<{ specId: string; criterionId: string }> };

/**
 * GET /api/specs/[specId]/criteria/[criterionId]: one criterion's history
 * ("Reviewing a spec revision" R-12, R-15): every revision in which its words
 * changed, with the change summary, who wrote it and whether that wording was
 * approved, continuing the history of any criteria it replaces. Read-only.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { specId, criterionId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const r = await specCriterionHistory(caller, specId, decodeURIComponent(criterionId).toUpperCase());
  return r.ok ? NextResponse.json({ history: r.history }) : NextResponse.json({ error: r.error }, { status: r.status });
}
