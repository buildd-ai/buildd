import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { specDiscrepancies } from '@buildd/core/db/schema';
import { and, asc, eq, type SQL } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

const DIRECTIONS = ['spec_ahead', 'code_ahead', 'contradicted'] as const;
const STATUSES = ['open', 'accepted', 'resolved'] as const;

// GET /api/discrepancies?workspaceId=&direction=&status= — §13 list_discrepancies backing route.
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get('workspaceId');
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
  }

  if (user && !apiAccount) {
    const access = await verifyWorkspaceAccess(user.id, workspaceId);
    if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  } else if (apiAccount) {
    const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, workspaceId);
    if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const directionFilter = searchParams.get('direction');
  const statusFilter = searchParams.get('status');
  if (directionFilter && !(DIRECTIONS as readonly string[]).includes(directionFilter)) {
    return NextResponse.json({ error: `direction must be one of: ${DIRECTIONS.join(', ')}` }, { status: 400 });
  }
  if (statusFilter && !(STATUSES as readonly string[]).includes(statusFilter)) {
    return NextResponse.json({ error: `status must be one of: ${STATUSES.join(', ')}` }, { status: 400 });
  }

  const conditions: SQL[] = [eq(specDiscrepancies.workspaceId, workspaceId)];
  if (directionFilter) conditions.push(eq(specDiscrepancies.direction, directionFilter as (typeof DIRECTIONS)[number]));
  if (statusFilter) conditions.push(eq(specDiscrepancies.status, statusFilter as (typeof STATUSES)[number]));

  const rows = await db
    .select()
    .from(specDiscrepancies)
    .where(and(...conditions))
    .orderBy(asc(specDiscrepancies.firstSeenAt));

  return NextResponse.json({ discrepancies: rows });
}
