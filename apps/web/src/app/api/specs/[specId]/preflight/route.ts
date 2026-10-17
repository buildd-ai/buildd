import { NextRequest, NextResponse } from 'next/server';
import { specRepoChecks } from '@/lib/specs/page-view';
import { specCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * GET /api/specs/[specId]/preflight: the repo checks on the waiting
 * revision's would-be repo copy (living-specs.md §18, R-34), for a person who
 * may approve. The spec page's review panel fetches this after it shows, so
 * GitHub is never on the path of opening Review. `preflight` is null when the
 * workspace writes no repo copies.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const r = await specRepoChecks(caller, specId);
  return r.ok ? NextResponse.json({ revision: r.revision, preflight: r.preflight }) : NextResponse.json({ error: r.error }, { status: r.status });
}
