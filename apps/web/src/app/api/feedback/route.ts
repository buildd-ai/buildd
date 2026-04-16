import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { userFeedback } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';

const VALID_ENTITY_TYPES = ['note', 'artifact', 'summary', 'orchestration', 'heartbeat'] as const;
const VALID_SIGNALS = ['up', 'down', 'dismiss'] as const;

// POST /api/feedback — submit or update feedback on AI content
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { entityType, entityId, signal, comment } = body;

    if (!entityType || !VALID_ENTITY_TYPES.includes(entityType)) {
      return NextResponse.json(
        { error: `Invalid entityType. Must be one of: ${VALID_ENTITY_TYPES.join(', ')}` },
        { status: 400 }
      );
    }
    if (!entityId || typeof entityId !== 'string') {
      return NextResponse.json({ error: 'entityId is required' }, { status: 400 });
    }
    if (!signal || !VALID_SIGNALS.includes(signal)) {
      return NextResponse.json(
        { error: `Invalid signal. Must be one of: ${VALID_SIGNALS.join(', ')}` },
        { status: 400 }
      );
    }

    const teamIds = await getUserTeamIds(user.id);
    if (teamIds.length === 0) {
      return NextResponse.json({ error: 'No team found' }, { status: 403 });
    }

    // Upsert: if user already gave feedback on this entity, update it
    const existing = await db.query.userFeedback.findFirst({
      where: and(
        eq(userFeedback.userId, user.id),
        eq(userFeedback.entityType, entityType),
        eq(userFeedback.entityId, entityId),
      ),
    });

    if (existing) {
      // If same signal, remove the feedback (toggle off)
      if (existing.signal === signal) {
        await db.delete(userFeedback).where(eq(userFeedback.id, existing.id));
        return NextResponse.json({ removed: true, entityType, entityId });
      }
      // Otherwise update to new signal
      const [updated] = await db.update(userFeedback)
        .set({ signal, comment: comment || null })
        .where(eq(userFeedback.id, existing.id))
        .returning();
      return NextResponse.json(updated);
    }

    const [entry] = await db.insert(userFeedback).values({
      userId: user.id,
      teamId: teamIds[0],
      entityType,
      entityId,
      signal,
      comment: comment || null,
    }).returning();

    return NextResponse.json(entry, { status: 201 });
  } catch (error) {
    console.error('Feedback error:', error);
    return NextResponse.json({ error: 'Failed to save feedback' }, { status: 500 });
  }
}

// GET /api/feedback?entityType=note&entityIds=id1,id2 — batch fetch user's feedback
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const entityType = url.searchParams.get('entityType');
  const entityIds = url.searchParams.get('entityIds')?.split(',').filter(Boolean);

  if (!entityType || !VALID_ENTITY_TYPES.includes(entityType as any)) {
    return NextResponse.json({ error: 'entityType is required' }, { status: 400 });
  }

  try {
    const conditions = [
      eq(userFeedback.userId, user.id),
      eq(userFeedback.entityType, entityType as typeof VALID_ENTITY_TYPES[number]),
    ];

    const results = await db.query.userFeedback.findMany({
      where: and(...conditions),
    });

    // Filter by entityIds client-side if provided (to avoid dynamic IN clause)
    const filtered = entityIds
      ? results.filter(r => entityIds.includes(r.entityId))
      : results;

    // Return as a map for easy client-side lookup
    const feedbackMap: Record<string, string> = {};
    for (const r of filtered) {
      feedbackMap[r.entityId] = r.signal;
    }

    return NextResponse.json({ feedback: feedbackMap });
  } catch (error) {
    console.error('Feedback fetch error:', error);
    return NextResponse.json({ error: 'Failed to fetch feedback' }, { status: 500 });
  }
}
