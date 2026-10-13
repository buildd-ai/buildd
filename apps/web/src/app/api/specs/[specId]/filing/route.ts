import { NextRequest, NextResponse } from 'next/server';
import { specCaller } from '@/lib/specs/caller';
import { actOnFiling, readFiling } from '@/lib/specs/organize';

type Ctx = { params: Promise<{ specId: string }> };

/** GET /api/specs/[specId]/filing: where buildd filed this spec ("Filed by buildd"), or the place it suggests, if any. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const r = await readFiling(caller, specId);
  return r.ok ? NextResponse.json({ filing: r.filing }) : NextResponse.json({ error: r.error }, { status: r.status });
}

/**
 * POST /api/specs/[specId]/filing { action: 'undo' | 'accept' | 'dismiss', filingId }:
 * undo a filing buildd made (the previous parent comes back; the version does
 * not move), accept a suggested area (a placement by hand) or dismiss it.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
  const r = await actOnFiling(caller, specId, body as { action: unknown; filingId: unknown });
  return r.ok ? NextResponse.json({ filing: r.filing }) : NextResponse.json({ error: r.error }, { status: r.status });
}
