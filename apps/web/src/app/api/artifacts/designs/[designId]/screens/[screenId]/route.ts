import { NextRequest, NextResponse } from 'next/server';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { bearerOf, linkCaller } from '@/lib/artifact-link-caller';
import { readDesignScreen } from '@/lib/designs/service';

type Ctx = { params: Promise<{ designId: string; screenId: string }> };

/**
 * GET /api/artifacts/designs/[designId]/screens/[screenId]?revision=: one
 * screen of a design revision on its own ("Designs in buildd" R-15): that
 * board's source without the other boards, and a render URL to open at its
 * viewport. The current revision when none is named.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { designId, screenId } = await params;
  const account = await authenticateTaskScopedCaller(bearerOf(req), req);
  const caller = await linkCaller(account, account?.taskScope ?? null);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const raw = req.nextUrl.searchParams.get('revision');
  const revision = raw === null ? undefined : Number(raw);
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) {
    return NextResponse.json({ error: 'revision must be a positive integer', field: 'revision' }, { status: 400 });
  }
  const r = await readDesignScreen(caller, designId, { screenId, ...(revision !== undefined ? { revision } : {}) });
  if (!r.ok) return NextResponse.json({ error: r.error, ...(r.field ? { field: r.field } : {}) }, { status: r.status });
  const { ok: _ok, ...body } = r;
  return NextResponse.json(body);
}
