import { db } from '@buildd/core/db';
import { platformAdminAuditEvents } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import type { AdminRecoveryCapability } from '@buildd/shared';

export type PlatformAdminAuditAction = 'experiment.update' | 'team.experiment_flags.update' | 'decision_feature.mode.update'
  | 'decision_measurement.update' | 'decision_measurement.retire'
  /** Owner recovery actions (operator-recovery spec §7.2): `recovery.<capability>`. */
  | `recovery.${AdminRecoveryCapability}`;

export type PlatformAdminAuditTarget = 'experiment' | 'team' | 'decision_feature' | 'decision_measurement'
  | 'cause' | 'incident' | 'automation';

export interface PlatformAdminAuditInput {
  actorAccountId: string;
  action: PlatformAdminAuditAction;
  targetType: PlatformAdminAuditTarget;
  targetId: string;
  teamId: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/**
 * One append-only row per write made through the platform-owner API. Awaited
 * by the caller after the write lands: a write whose audit row fails answers
 * 500, never a success the trail does not show.
 */
export async function recordPlatformAdminAudit(event: PlatformAdminAuditInput): Promise<void> {
  await db.insert(platformAdminAuditEvents).values(asRow(event));
}

type AuditRow = typeof platformAdminAuditEvents.$inferInsert;
/** `target_type` is plain text; the schema's narrower `$type` predates the recovery targets. */
const asRow = (event: PlatformAdminAuditInput): AuditRow => event as unknown as AuditRow;

/**
 * The intent half of a recovery action's audit (operator-recovery §7.2 step 7):
 * written BEFORE the action, with `after = { phase: 'intent', ... }`, so no
 * action can report applied without its row. Returns the row id; a throw means
 * the action must not run.
 */
export async function recordPlatformAdminAuditIntent(event: Omit<PlatformAdminAuditInput, 'after'> & { after: Record<string, unknown> }): Promise<string> {
  const [row] = await db.insert(platformAdminAuditEvents)
    .values(asRow({ ...event, after: { ...event.after, phase: 'intent' } }))
    .returning({ id: platformAdminAuditEvents.id });
  if (!row) throw new Error('audit intent was not written');
  return row.id;
}

/**
 * Complete an intent row once, with the post-action `after`. The row stays the
 * one row for the action (OR-2); a second completion matches nothing. Returns
 * false when the row was not an open intent.
 */
export async function completePlatformAdminAudit(id: string, after: Record<string, unknown>): Promise<boolean> {
  const rows = await db.update(platformAdminAuditEvents)
    .set({ after })
    .where(and(eq(platformAdminAuditEvents.id, id), sql`${platformAdminAuditEvents.after}->>'phase' = 'intent'`))
    .returning({ id: platformAdminAuditEvents.id });
  return rows.length > 0;
}
