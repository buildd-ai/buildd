import { NextRequest, NextResponse } from 'next/server';
import { diffSpecRevisions } from '@/lib/specs/diff';
import { specCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

function revisionParam(raw: string | null): number | undefined | null {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * GET /api/specs/[specId]/diff?from=&to=: what changed between two revisions,
 * read-only. `to` defaults to the head; `from` to the approved revision, else
 * the one before `to`. Sections added, removed and changed, then a capped
 * unified line diff of them with a count of the lines it left out.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const from = revisionParam(req.nextUrl.searchParams.get('from'));
  const to = revisionParam(req.nextUrl.searchParams.get('to'));
  if (from === null || to === null) return NextResponse.json({ error: 'from and to must be positive integers' }, { status: 400 });
  const r = await diffSpecRevisions(caller, specId, { from, to });
  return r.ok ? NextResponse.json(r.diff) : NextResponse.json({ error: r.error }, { status: r.status });
}
