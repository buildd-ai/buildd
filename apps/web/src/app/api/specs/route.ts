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

/**
 * POST /api/specs { workspaceId, title, body, scope?, parentSpecId?, changeSummary?, design?, supersedes?, distinctBecause? }:
 * a new draft, revision 1. A clear duplicate of an approved spec is a 409 with `code: spec_duplicate`
 * and the `duplicates`, unless `supersedes` or `distinctBecause` overrides it (lib/specs/duplicate-check.ts).
 */
export async function POST(req: NextRequest) {
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
  const r = await createSpecDraft(caller, body);
  if (r.ok) return NextResponse.json({ spec: r.spec, revision: r.revision, duplicateCheck: r.duplicateCheck }, { status: 201 });
  return NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.duplicates ? { duplicates: r.duplicates } : {}) }, { status: r.status });
}
