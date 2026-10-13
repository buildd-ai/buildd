import { NextRequest, NextResponse } from 'next/server';
import { attachProvisional } from '@/lib/specs/provisional';
import { specCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * POST /api/specs/[specId]/provisional { revision, taskIds }: attach finished
 * tasks to the revision they were built against, provisionally, so a later
 * approval grades them (living-specs.md §20, R-43; lib/specs/provisional.ts).
 * A person or an admin token only: an agent run or a plain API key is a 403.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { revision?: unknown; taskIds?: unknown } | null;
  const r = await attachProvisional(caller, specId, { revision: body?.revision, taskIds: body?.taskIds });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ revision: r.revision, provisional: r.provisional, results: r.results, regraded: r.regraded });
}
