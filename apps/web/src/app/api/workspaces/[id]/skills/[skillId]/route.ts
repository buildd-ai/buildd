import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { skills, workspaces, accounts } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';

type RouteParams = { params: Promise<{ id: string; skillId: string }> };

async function authenticateRequest(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.apiKey, hashApiKey(apiKey)),
    });
    if (account) return { type: 'api' as const, account };
  }

  if (process.env.NODE_ENV !== 'development') {
    const user = await getCurrentUser();
    if (user) return { type: 'session' as const, user };
  } else {
    return { type: 'dev' as const };
  }

  return null;
}

async function verifyWorkspace(id: string, auth: NonNullable<Awaited<ReturnType<typeof authenticateRequest>>>) {
  const wsConditions = [eq(workspaces.id, id)];
  if (auth.type === 'session') {
    wsConditions.push(eq(workspaces.ownerId, auth.user.id));
  }
  return db.query.workspaces.findFirst({
    where: and(...wsConditions),
    columns: { id: true },
  });
}

// GET /api/workspaces/[id]/skills/[skillId]
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id, skillId } = await params;
  const auth = await authenticateRequest(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const skill = await db.query.skills.findFirst({
    where: and(eq(skills.id, skillId), eq(skills.workspaceId, id)),
  });

  if (!skill) {
    return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
  }

  return NextResponse.json({ skill });
}

// PATCH /api/workspaces/[id]/skills/[skillId]
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id, skillId } = await params;
  const auth = await authenticateRequest(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const workspace = await verifyWorkspace(id, auth);
  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const existing = await db.query.skills.findFirst({
    where: and(eq(skills.id, skillId), eq(skills.workspaceId, id)),
  });

  if (!existing) {
    return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
  }

  try {
    const body = await req.json();
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (body.name !== undefined) updates.name = body.name;
    if (body.slug !== undefined) updates.slug = body.slug;
    if (body.description !== undefined) updates.description = body.description;
    if (body.content !== undefined) updates.content = body.content;
    if (body.metadata !== undefined) updates.metadata = body.metadata;
    if (body.enabled !== undefined) updates.enabled = body.enabled;

    // If slug is being changed, check uniqueness
    if (body.slug && body.slug !== existing.slug) {
      const duplicate = await db.query.skills.findFirst({
        where: and(eq(skills.workspaceId, id), eq(skills.slug, body.slug)),
        columns: { id: true },
      });
      if (duplicate) {
        return NextResponse.json(
          { error: `Skill with slug "${body.slug}" already exists` },
          { status: 409 }
        );
      }
    }

    const [updated] = await db
      .update(skills)
      .set(updates)
      .where(eq(skills.id, skillId))
      .returning();

    return NextResponse.json({ skill: updated });
  } catch (error) {
    console.error('Update skill error:', error);
    return NextResponse.json({ error: 'Failed to update skill' }, { status: 500 });
  }
}

// DELETE /api/workspaces/[id]/skills/[skillId]
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { id, skillId } = await params;
  const auth = await authenticateRequest(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const workspace = await verifyWorkspace(id, auth);
  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const [deleted] = await db
    .delete(skills)
    .where(and(eq(skills.id, skillId), eq(skills.workspaceId, id)))
    .returning();

  if (!deleted) {
    return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
