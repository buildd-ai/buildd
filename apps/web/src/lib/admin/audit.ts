import { db } from '@buildd/core/db';
import { platformAdminAuditEvents } from '@buildd/core/db/schema';

export interface PlatformAdminAuditInput {
  actorAccountId: string;
  action: 'experiment.update' | 'team.experiment_flags.update';
  targetType: 'experiment' | 'team';
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
  await db.insert(platformAdminAuditEvents).values(event);
}
