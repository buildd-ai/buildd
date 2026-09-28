import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { userFeedback } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, verifyWorkspaceAccess } from '@/lib/team-access';
import { resolveFeedbackEntityHome } from '@/lib/feedback-entity-workspace';
import { rateableTurnTeam } from '@/lib/chat/turn-feedback';
import { isChatFeedbackReason, type ChatFeedbackReason } from '@buildd/core/tier-pool';

// 'conversation_message' = thumbs on an assistant chat turn
// (docs/design/tier-model-pools.md). It carries a reason label, never a comment.
const VALID_ENTITY_TYPES = ['note', 'artifact', 'summary', 'orchestration', 'heartbeat', 'conversation_message'] as const;
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

    const isTurn = entityType === 'conversation_message';
    let teamId: string;
    let reason: ChatFeedbackReason | null = null;
    let note: string | null = comment || null;
    if (isTurn) {
      // Only the owner of the conversation can rate its assistant turns, and
      // the vote belongs to the conversation's team.
      if (signal === 'dismiss') {
        return NextResponse.json({ error: 'A chat turn takes up or down' }, { status: 400 });
      }
      if (body.reason != null && (signal !== 'down' || !isChatFeedbackReason(body.reason))) {
        return NextResponse.json({ error: 'reason must be one of the thumbs-down reasons, on a down vote' }, { status: 400 });
      }
      const turnTeam = await rateableTurnTeam(entityId, user.id);
      if (!turnTeam) return NextResponse.json({ error: 'Message not found' }, { status: 404 });
      teamId = turnTeam;
      reason = body.reason ?? null;
      note = null; // Labels and numbers only: chat thumbs never store text.
    } else {
      // Invariant: feedback on content comes only from someone who can reach
      // it (workspace access, or team membership for team-level content with
      // no workspace), and belongs to that content's team. Content outside the
      // rater's reach reads the same as missing content.
      const home = await resolveFeedbackEntityHome(entityType, entityId);
      let contentTeam: string | null = null;
      if (home?.workspaceId) {
        contentTeam = (await verifyWorkspaceAccess(user.id, home.workspaceId))?.teamId ?? null;
      } else if (home && home.workspaceId === null) {
        contentTeam = (await getUserTeamIds(user.id)).includes(home.teamId) ? home.teamId : null;
      }
      if (!contentTeam) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      teamId = contentTeam;
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
      // Same signal again removes it (toggle off). A down vote that now names
      // a reason updates the reason instead: that is the reason sheet's tap.
      const addsReason = isTurn && reason !== null && reason !== existing.reason;
      if (existing.signal === signal && !addsReason) {
        await db.delete(userFeedback).where(eq(userFeedback.id, existing.id));
        return NextResponse.json({ removed: true, entityType, entityId });
      }
      const [updated] = await db.update(userFeedback)
        .set({ signal, comment: note, ...(isTurn ? { reason } : {}) })
        .where(eq(userFeedback.id, existing.id))
        .returning();
      return NextResponse.json(updated);
    }

    const [entry] = await db.insert(userFeedback).values({
      userId: user.id,
      teamId,
      entityType,
      entityId,
      signal,
      comment: note,
      ...(isTurn ? { reason } : {}),
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
    const reasons: Record<string, string> = {};
    for (const r of filtered) {
      feedbackMap[r.entityId] = r.signal;
      if (r.reason) reasons[r.entityId] = r.reason;
    }

    return NextResponse.json({ feedback: feedbackMap, ...(entityType === 'conversation_message' ? { reasons } : {}) });
  } catch (error) {
    console.error('Feedback fetch error:', error);
    return NextResponse.json({ error: 'Failed to fetch feedback' }, { status: 500 });
  }
}
