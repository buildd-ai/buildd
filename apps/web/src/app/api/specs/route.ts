import { NextRequest, NextResponse } from 'next/server';
import { createSpecDraft, listSpecs } from '@/lib/specs/store';
import { specCaller } from '@/lib/specs/caller';

/** GET /api/specs?workspaceId=: the workspace's Living Specs. */
export async function GET(req: NextRequest) {
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const r = await listSpecs(caller, req.nextUrl.searchParams.get('workspaceId') ?? '');
  return r.ok ? NextResponse.json({ specs: r.specs }) : NextResponse.json({ error: r.error }, { status: r.status });
}

/** POST /api/specs { workspaceId, title, body, scope?, parentSpecId?, changeSummary? }: a new draft, revision 1. */
export async function POST(req: NextRequest) {
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
  const r = await createSpecDraft(caller, body);
  return r.ok ? NextResponse.json({ spec: r.spec, revision: r.revision }, { status: 201 }) : NextResponse.json({ error: r.error }, { status: r.status });
}
