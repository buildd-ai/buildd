import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { skills } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';

// PATCH /api/skills/[skillId] — update skill hash/metadata
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ skillId: string }> }
) {
  const { skillId } = await params;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const teamIds = await getUserTeamIds(user.id);
    if (teamIds.length === 0) {
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
    }

    const body = await req.json();
    const { name, description, contentHash, source, sourceVersion } = body;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description || null;
    if (contentHash !== undefined) updates.contentHash = contentHash;
    if (source !== undefined) updates.source = source || null;
    if (sourceVersion !== undefined) updates.sourceVersion = sourceVersion || null;

    const [updated] = await db
      .update(skills)
      .set(updates)
      .where(and(eq(skills.id, skillId), inArray(skills.teamId, teamIds)))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
    }

    return NextResponse.json({ skill: updated });
  } catch (error) {
    console.error('Update skill error:', error);
    return NextResponse.json({ error: 'Failed to update skill' }, { status: 500 });
  }
}

// DELETE /api/skills/[skillId] — unregister skill
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ skillId: string }> }
) {
  const { skillId } = await params;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const teamIds = await getUserTeamIds(user.id);
    if (teamIds.length === 0) {
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
    }

    const [deleted] = await db
      .delete(skills)
      .where(and(eq(skills.id, skillId), inArray(skills.teamId, teamIds)))
      .returning();

    if (!deleted) {
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete skill error:', error);
    return NextResponse.json({ error: 'Failed to delete skill' }, { status: 500 });
  }
}
