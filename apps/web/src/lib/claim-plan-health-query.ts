import 'server-only';
import { db } from '@buildd/core/db';
import { gateEvents } from '@buildd/core/db/schema';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { GATE_SLUGS } from '@buildd/core/gate-events';
import { CLAIM_PLAN_REASON } from '@/app/api/workers/claim/claim-plan-store';
import { summarizeClaimPlans, type ClaimPlanHealth } from './claim-plan-health';

const CLAIM_PLAN_HEALTH_MAX_ROWS = 2000;

/** The claim-plan ledger for the scoped workspaces over the window; callers pass only workspaces the viewer may see. */
export async function loadClaimPlanHealth(opts: { workspaceIds: string[]; since: Date }): Promise<ClaimPlanHealth> {
  if (opts.workspaceIds.length === 0) return summarizeClaimPlans([]);
  const rows = await db.select({ occurredAt: gateEvents.occurredAt, detail: gateEvents.detail })
    .from(gateEvents)
    .where(and(
      inArray(gateEvents.workspaceId, opts.workspaceIds),
      eq(gateEvents.gate, GATE_SLUGS.CLAIM_LOOP_DEFERRAL),
      eq(gateEvents.reason, CLAIM_PLAN_REASON),
      eq(gateEvents.outcome, 'accepted'),
      gte(gateEvents.occurredAt, opts.since),
    ))
    .orderBy(desc(gateEvents.occurredAt))
    .limit(CLAIM_PLAN_HEALTH_MAX_ROWS);
  return summarizeClaimPlans(rows);
}
