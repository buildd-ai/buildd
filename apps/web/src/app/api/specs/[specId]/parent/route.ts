import { NextRequest, NextResponse } from 'next/server';
import { relateSpec } from '@/lib/specs/store';
import { specCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * PUT /api/specs/[specId]/parent { parentSpecId: uuid | null }: set, change or
 * clear the parent spec. Same workspace only; a parent that is the spec or one
 * of its descendants is a 409 (it would form a cycle).
 */
export async function PUT(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('parentSpecId' in body)) {
    return NextResponse.json({ error: 'parentSpecId is required (a spec UUID, or null to clear it)' }, { status: 400 });
  }
  const r = await relateSpec(caller, specId, body as { parentSpecId: unknown });
  return r.ok ? NextResponse.json({ spec: r.spec }) : NextResponse.json({ error: r.error }, { status: r.status });
}
