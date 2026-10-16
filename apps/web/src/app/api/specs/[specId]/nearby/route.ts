import { NextRequest, NextResponse } from 'next/server';
import { specCaller } from '@/lib/specs/caller';
import { getSpec } from '@/lib/specs/store';
import { readSpecNeighbours, suggestParent } from '@/lib/specs/neighbours';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * GET /api/specs/[specId]/nearby: the spec's neighbours (living-specs.md §14),
 * each with its kind and reason, and, for a spec with no parent, the parent it
 * most likely belongs under. Read-only and derived: nothing here approves,
 * pins or changes the spec.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const got = await getSpec(caller, specId);
  if (!got.ok) return NextResponse.json({ error: got.error }, { status: got.status });
  const nearby = await readSpecNeighbours(specId).catch(() => []);
  const suggestedParent = got.view.spec.parentSpecId
    ? null
    : await suggestParent(got.view.spec.workspaceId, specId, `${got.view.spec.title}\n\n${got.view.body}`).catch(() => null);
  return NextResponse.json({ nearby, suggestedParent });
}
