import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { initiatives, workspaces, systemCache } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { evaluateInitiativeKPIs } from '@buildd/core/mission-helpers';

const RATE_LIMIT_PER_HOUR = 6;
const ONE_HOUR_MS = 60 * 60 * 1000;

async function hasInitiativeAccess(initiative: { teamId: string; workspaceId: string | null }, teamIds: string[]): Promise<boolean> {
  if (teamIds.includes(initiative.teamId)) return true;
  if (initiative.workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, initiative.workspaceId),
      columns: { accessMode: true },
    });
    if (ws?.accessMode === 'open') return true;
  }
  return false;
}

/** Track and check rate limit using system_cache. Returns true if request should be blocked. */
async function isRateLimited(initiativeId: string): Promise<boolean> {
  const cacheKey = `initiative:eval-rate:${initiativeId}`;
  const now = Date.now();
  const cutoff = now - ONE_HOUR_MS;

  const existing = await db.query.systemCache.findFirst({ where: eq(systemCache.key, cacheKey) });
  const timestamps: number[] = (existing?.value as number[] | null) ?? [];

  // Drop timestamps older than 1 hour
  const recent = timestamps.filter(t => t > cutoff);

  if (recent.length >= RATE_LIMIT_PER_HOUR) return true;

  // Update cache with the new timestamp appended
  recent.push(now);
  const expiresAt = new Date(now + ONE_HOUR_MS + 60_000); // TTL: 1h + buffer
  await db
    .insert(systemCache)
    .values({ key: cacheKey, value: recent as any, updatedAt: new Date(), expiresAt })
    .onConflictDoUpdate({
      target: systemCache.key,
      set: { value: recent as any, updatedAt: new Date(), expiresAt },
    });

  return false;
}

/**
 * POST /api/initiatives/[id]/evaluate
 *
 * On-demand evaluation of an initiative's KPIs.
 * Returns InitiativeKPIState with per-KPI verdicts.
 * Rate limited to 6 calls per initiative per hour.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);

    const initiative = await db.query.initiatives.findFirst({
      where: eq(initiatives.id, id),
      columns: {
        id: true,
        teamId: true,
        workspaceId: true,
        kpis: true,
        status: true,
      },
    });

    if (!initiative || !(await hasInitiativeAccess(initiative, teamIds))) {
      return NextResponse.json({ error: 'Initiative not found' }, { status: 404 });
    }

    const kpis = (initiative.kpis as any[]) ?? [];
    if (kpis.length === 0) {
      return NextResponse.json({
        message: 'No KPIs set — nothing to evaluate',
        kpiState: null,
      });
    }

    if (await isRateLimited(id)) {
      return NextResponse.json(
        { error: `Rate limit: max ${RATE_LIMIT_PER_HOUR} on-demand evaluations per initiative per hour` },
        { status: 429 }
      );
    }

    const evaluatedBy: 'auto' | 'manual' | 'mcp' = apiAccount ? 'mcp' : 'manual';

    const state = evaluateInitiativeKPIs(id, kpis as any, { evaluatedBy });

    // Persist state; if all blocking KPIs pass and initiative is active + all missions done,
    // allow initiative to complete. (Initiative completion from KPI gate is advisory here —
    // the full transition is owned by computeInitiativeProgress + organizer.)
    await db
      .update(initiatives)
      .set({ kpiState: state as any, updatedAt: new Date() })
      .where(eq(initiatives.id, id));

    return NextResponse.json({ kpiState: state });
  } catch (error) {
    console.error('Evaluate initiative KPIs error:', error);
    return NextResponse.json({ error: 'Failed to evaluate initiative KPIs' }, { status: 500 });
  }
}

/**
 * GET /api/initiatives/[id]/evaluate
 *
 * Returns the last InitiativeKPIState without re-evaluating (get_kpi_state).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);

    const initiative = await db.query.initiatives.findFirst({
      where: eq(initiatives.id, id),
      columns: { id: true, teamId: true, workspaceId: true, kpis: true, kpiState: true },
    });

    if (!initiative || !(await hasInitiativeAccess(initiative, teamIds))) {
      return NextResponse.json({ error: 'Initiative not found' }, { status: 404 });
    }

    return NextResponse.json({
      kpis: initiative.kpis ?? null,
      kpiState: initiative.kpiState ?? null,
    });
  } catch (error) {
    console.error('Get initiative KPI state error:', error);
    return NextResponse.json({ error: 'Failed to get KPI state' }, { status: 500 });
  }
}
