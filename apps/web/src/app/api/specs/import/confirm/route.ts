import { NextRequest, NextResponse } from 'next/server';
import { specCaller } from '@/lib/specs/caller';
import { confirmImportedSpecs } from '@/lib/specs/import';

/**
 * POST /api/specs/import/confirm { workspaceId, specIds }: a person confirms a
 * batch of imported specs in one act (living-specs.md §18, R-19). Each is
 * approved only while its repo file is unchanged since the imported commit;
 * one whose file moved is reported stale and stays imported. An agent run or
 * API key is a 403. From an OAuth session nothing is approved: the reply is a
 * 202 with the link to the specs page, where the person confirms.
 */
export async function POST(req: NextRequest) {
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { workspaceId?: unknown; specIds?: unknown } | null;
  const r = await confirmImportedSpecs(caller, { workspaceId: body?.workspaceId, specIds: body?.specIds });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r.result, { status: r.result.pending ? 202 : 200 });
}
