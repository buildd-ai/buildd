import { NextRequest, NextResponse } from 'next/server';
import { restoreSpec, retireSpec } from '@/lib/specs/retire';
import { specCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * POST /api/specs/[specId]/retire { reason, supersededBy? }: a person retires
 * a spec, or marks it superseded by another live spec in the same workspace
 * (lib/specs/retire.ts, living-specs.md §22). DELETE { reason? } restores it
 * to the status it had. An agent run or API key is a 403 on both.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { reason?: unknown; supersededBy?: unknown } | null;
  const r = await retireSpec(caller, specId, { reason: body?.reason, supersededBy: body?.supersededBy });
  if (r.ok) return NextResponse.json({ spec: r.spec });
  return NextResponse.json({ error: r.error }, { status: r.status });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { reason?: unknown } | null;
  const r = await restoreSpec(caller, specId, { reason: body?.reason });
  if (r.ok) return NextResponse.json({ spec: r.spec });
  return NextResponse.json({ error: r.error }, { status: r.status });
}
