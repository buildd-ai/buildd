import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { specDiscrepancies } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { planAdjudication, type AdjudicationAction, type Direction } from '@buildd/core/spec-discrepancy-ledger';

// POST /api/discrepancies/[id]/adjudicate — §13 adjudicate_discrepancy backing
// route: { action: 'accept' | 'flip_direction', reason, newDirection? }.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  const row = await db.query.specDiscrepancies.findFirst({ where: eq(specDiscrepancies.id, id) });
  if (!row) return NextResponse.json({ error: 'Discrepancy not found' }, { status: 404 });

  if (user && !apiAccount) {
    const access = await verifyWorkspaceAccess(user.id, row.workspaceId);
    if (!access) return NextResponse.json({ error: 'Discrepancy not found' }, { status: 404 });
  } else if (apiAccount) {
    const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, row.workspaceId);
    if (!hasAccess) return NextResponse.json({ error: 'Discrepancy not found' }, { status: 404 });
  }

  let body: { action?: AdjudicationAction; reason?: string; newDirection?: Direction };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  let patch: ReturnType<typeof planAdjudication>;
  try {
    patch = planAdjudication(
      { direction: row.direction, status: row.status },
      { action: body.action as AdjudicationAction, reason: body.reason, newDirection: body.newDirection }
    );
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Atomic UPDATE...WHERE on the same precondition `planAdjudication` just
  // validated (per CLAUDE.md: no db.transaction() on the neon-http driver —
  // use a conditional UPDATE for optimistic locking instead). Zero rows back
  // means the row moved between the read above and this write; re-fetch to
  // report the actual current state rather than a stale "success".
  const precondition =
    body.action === 'accept'
      ? and(eq(specDiscrepancies.id, id), eq(specDiscrepancies.status, row.status))
      : and(eq(specDiscrepancies.id, id), eq(specDiscrepancies.direction, 'contradicted'));

  const [updated] = await db
    .update(specDiscrepancies)
    .set(patch)
    .where(precondition)
    .returning();

  if (!updated) {
    const fresh = await db.query.specDiscrepancies.findFirst({ where: eq(specDiscrepancies.id, id) });
    return NextResponse.json(
      {
        error:
          'Discrepancy changed between read and write (concurrent adjudication or a CI re-run) — no update applied.',
        discrepancy: fresh ?? null,
      },
      { status: 409 }
    );
  }

  return NextResponse.json({ discrepancy: updated });
}
