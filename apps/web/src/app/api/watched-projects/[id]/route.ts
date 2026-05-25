import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { watchedProjects, accounts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { parseUpdateInput } from '@/lib/watched-project-input';

async function loadAndAuthorize(req: NextRequest, projectId: string): Promise<
  | { ok: true; row: typeof watchedProjects.$inferSelect }
  | { ok: false; status: number; error: string }
> {
  const row = await db.query.watchedProjects.findFirst({
    where: eq(watchedProjects.id, projectId),
  });
  if (!row) return { ok: false, status: 404, error: 'Not found' };

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.apiKey, hashApiKey(apiKey)),
    });
    if (account) {
      const ok = await verifyAccountWorkspaceAccess(account.id, row.workspaceId, 'canCreate');
      if (!ok) return { ok: false, status: 401, error: 'Unauthorized' };
      return { ok: true, row };
    }
  }

  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' };
  const access = await verifyWorkspaceAccess(user.id, row.workspaceId);
  if (!access) return { ok: false, status: 401, error: 'Unauthorized' };
  return { ok: true, row };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await loadAndAuthorize(req, id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ watchedProject: auth.row });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await loadAndAuthorize(req, id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  let patch;
  try {
    patch = parseUpdateInput(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid input' }, { status: 400 });
  }

  const [updated] = await db
    .update(watchedProjects)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(watchedProjects.id, id))
    .returning();
  return NextResponse.json({ watchedProject: updated });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await loadAndAuthorize(req, id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  await db.delete(watchedProjects).where(eq(watchedProjects.id, id));
  return NextResponse.json({ ok: true });
}
