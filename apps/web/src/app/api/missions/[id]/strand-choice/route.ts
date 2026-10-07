import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, decisionRecords, decisionOutcomes } from '@buildd/core/db/schema';
import { eq, desc } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { workspaceOpenToCaller } from '@/lib/open-workspaces';
import { emitDecisionLabel, strandLabelLine, STRAND_CHOICE_CAPABILITY } from '@/lib/strand-choice-decision';

const LABELS = new Set(['continue-on-runner', 'wait-for-local']);
const ORDERS = new Set(['runner-first', 'local-first']);

/**
 * POST /api/missions/[id]/strand-choice
 *
 * The owner's tap on a stranded local mission, recorded as the label for the
 * `mission_strand_choice` shadow (lib/strand-choice-decision.ts): which button
 * they took, and which order the card showed. Content-free, and it changes
 * nothing — "Continue on a runner" flips the executor through the mission
 * PATCH, which owns that write and its refusal.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid mission id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }

  const user = await getCurrentUser();
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);
  if (!user && !apiAccount) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (apiAccount && !hasTokenRouteAdminAccess(apiAccount, req)) {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  const body = await req.json().catch(() => null) as { label?: unknown; order?: unknown; quietMs?: unknown } | null;
  const label = body?.label;
  const order = body?.order;
  const quietMs = typeof body?.quietMs === 'number' && Number.isFinite(body.quietMs) ? Math.max(0, body.quietMs) : 0;
  if (typeof label !== 'string' || !LABELS.has(label) || typeof order !== 'string' || !ORDERS.has(order)) {
    return NextResponse.json({ error: 'label must be continue-on-runner or wait-for-local; order must be runner-first or local-first' }, { status: 400 });
  }

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);
    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, id),
      columns: { id: true, teamId: true, workspaceId: true },
    });
    const allowed = !!mission && (
      teamIds.includes(mission.teamId)
      || (!!mission.workspaceId && await workspaceOpenToCaller(mission.workspaceId, { teamIds, accountId: apiAccount?.id }))
    );
    if (!mission || !allowed) return NextResponse.json({ error: 'Mission not found' }, { status: 404 });

    emitDecisionLabel(strandLabelLine({
      missionId: id,
      label: label as 'continue-on-runner' | 'wait-for-local',
      order: order as 'runner-first' | 'local-first',
      quietMs,
    }));

    // Record the human choice as an outcome on the most recent decision record for this mission
    try {
      const mostRecentDecision = await db.query.decisionRecords.findFirst({
        where: (c) => c.and(
          c.eq(decisionRecords.missionId, id),
          c.eq(decisionRecords.capability, STRAND_CHOICE_CAPABILITY),
        ),
        orderBy: desc(decisionRecords.createdAt),
      });

      if (mostRecentDecision) {
        await db.insert(decisionOutcomes).values({
          decisionRecordId: mostRecentDecision.id,
          teamId: mostRecentDecision.teamId,
          capability: STRAND_CHOICE_CAPABILITY,
          source: 'human',
          label: 'human_choice',
          metadata: { button: label },
          observedAt: new Date(),
        }).catch(() => {});
      }
    } catch {
      // Outcome recording is non-fatal; the tap is still recorded in the log
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Record strand choice error:', error);
    return NextResponse.json({ error: 'Failed to record the choice' }, { status: 500 });
  }
}
