import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

/**
 * Authenticate via session or API key.
 * For API keys, requires admin-level account.
 * Returns { userId?, accountId? } or null.
 */
async function resolveAuth(req: NextRequest, workspaceId: string) {
  // Try session auth first (session users have full access)
  const user = await getCurrentUser();
  if (user) {
    const access = await verifyWorkspaceAccess(user.id, workspaceId);
    if (access) return { userId: user.id };
  }

  // Try API key auth — require admin level for heartbeat management
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);
  if (account) {
    if (account.level !== 'admin') return null; // Workers cannot manage heartbeat checklist
    const hasAccess = await verifyAccountWorkspaceAccess(account.id, workspaceId);
    if (hasAccess) return { accountId: account.id };
  }

  return null;
}

// GET /api/workspaces/[id]/heartbeat - Get workspace heartbeat checklist
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authResult = await resolveAuth(req, id);
  if (!authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    columns: { heartbeatChecklist: true },
  });

  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  return NextResponse.json({ checklist: workspace.heartbeatChecklist || [] });
}

// PATCH /api/workspaces/[id]/heartbeat - Update workspace heartbeat checklist
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authResult = await resolveAuth(req, id);
  if (!authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { checklist } = body;

    if (!Array.isArray(checklist) || !checklist.every((item: unknown) => typeof item === 'string')) {
      return NextResponse.json(
        { error: 'checklist must be an array of strings' },
        { status: 400 }
      );
    }

    const [updated] = await db
      .update(workspaces)
      .set({
        heartbeatChecklist: checklist,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, id))
      .returning({ heartbeatChecklist: workspaces.heartbeatChecklist });

    if (!updated) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    return NextResponse.json({ checklist: updated.heartbeatChecklist });
  } catch (error) {
    console.error('Update heartbeat checklist error:', error);
    return NextResponse.json({ error: 'Failed to update heartbeat checklist' }, { status: 500 });
  }
}
