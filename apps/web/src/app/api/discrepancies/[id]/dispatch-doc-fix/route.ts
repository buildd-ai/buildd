/**
 * POST /api/discrepancies/[id]/dispatch-doc-fix
 *
 * The "Dispatch doc fix" action on a grouped code-ahead DISCREPANCY card.
 *
 * docs/design/spec-conformance.md §8 says the only valid actions on a
 * `code_ahead` row are "accept, or a docs-only follow-up task". The surface
 * offered accept and nothing else, so a card that named the remedy in its own
 * label had no way to reach it. This is that follow-up task — the FIRST
 * dispatch path for a discrepancy, deliberately sited inside the existing
 * `/api/discrepancies/[id]/*` family next to `adjudicate` and `promote` rather
 * than as a new top-level surface. There is no pre-existing discrepancy
 * dispatch endpoint to widen: `apply-recommendation` is keyed on a PR number
 * and a reviewer note, neither of which a ledger row has.
 *
 * The promotion rule is untouched. This does not mint a mission, and
 * `promote_discrepancy` still refuses `code_ahead` rows exactly as before —
 * the whole point is that a doc fix is not a build.
 *
 * The claim, dedupe and closure rules live in lib/doc-fix-dispatch.ts, which
 * the hourly sweep's one automatic follow-up calls too — a human tap and the
 * automation take the same atomic claim and can never both dispatch.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { specDiscrepancies } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { dispatchDocFix } from '@/lib/doc-fix-dispatch';

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

  const result = await dispatchDocFix(row, {
    mode: 'initial',
    dispatchedBy: user?.email ?? 'api',
    creationSource: user ? 'dashboard' : 'api',
  });

  if (!result.ok) {
    const { httpStatus, ok, dispatched, code, taskId, error } = result;
    if (code) return NextResponse.json({ ok, dispatched, code, taskId: taskId ?? null, error }, { status: httpStatus });
    return NextResponse.json({ error }, { status: httpStatus });
  }
  return NextResponse.json(result);
}
