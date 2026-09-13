import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { specDiscrepancies } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

// GET /api/discrepancies/[id] — §13 get_discrepancy backing route. Returns the
// row including `evidence`, the exact read that produced the current verdict
// (never a similarity score — spec_compare already covers retrieval).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

  return NextResponse.json({ discrepancy: row });
}
