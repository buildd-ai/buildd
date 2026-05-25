import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { watchedProjects, accounts } from '@buildd/core/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { parseCreateInput } from '@/lib/watched-project-input';

async function authenticate(
  req: NextRequest,
  workspaceId: string,
  permission?: 'canCreate',
): Promise<{ ok: boolean; userId?: string }> {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.apiKey, hashApiKey(apiKey)),
    });
    if (account) {
      const ok = await verifyAccountWorkspaceAccess(account.id, workspaceId, permission);
      return { ok };
    }
  }

  const user = await getCurrentUser();
  if (!user) return { ok: false };
  const access = await verifyWorkspaceAccess(user.id, workspaceId);
  return { ok: !!access, userId: user.id };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const auth = await authenticate(req, workspaceId);
  if (!auth.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rows = await db
    .select()
    .from(watchedProjects)
    .where(eq(watchedProjects.workspaceId, workspaceId))
    .orderBy(desc(watchedProjects.createdAt));

  return NextResponse.json({ watchedProjects: rows });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const auth = await authenticate(req, workspaceId, 'canCreate');
  if (!auth.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  let input;
  try {
    input = parseCreateInput(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid input' }, { status: 400 });
  }

  const existing = await db
    .select({ id: watchedProjects.id })
    .from(watchedProjects)
    .where(and(eq(watchedProjects.workspaceId, workspaceId), eq(watchedProjects.repo, input.repo)))
    .limit(1);
  if (existing.length > 0) {
    return NextResponse.json({ error: `A watched project for ${input.repo} already exists in this workspace`, id: existing[0].id }, { status: 409 });
  }

  const [row] = await db
    .insert(watchedProjects)
    .values({
      workspaceId,
      repo: input.repo,
      enabled: input.enabled,
      vercelProjectId: input.vercelProjectId,
      inFlightWindowMin: input.inFlightWindowMin,
      prodGraceMin: input.prodGraceMin,
      roleSlug: input.roleSlug,
      pushoverApp: input.pushoverApp,
      releasePrFilter: input.releasePrFilter,
      notes: input.notes,
      createdByUserId: auth.userId ?? null,
    })
    .returning();

  return NextResponse.json({ watchedProject: row }, { status: 201 });
}
