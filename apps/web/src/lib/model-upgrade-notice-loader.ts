import { and, eq, gt } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { actionQueueSnoozes } from '@buildd/core/db/schema';
import { buildAdoptionReport } from '@buildd/core/model-adoption-report';
import { buildModelUpgradeNotice, type ModelUpgradeNotice } from '@/lib/model-upgrade-notice';

/**
 * The Home model-upgrade notice for one user and team, or null when nothing is
 * held back or this exact notice is snoozed (the action-queue snooze table,
 * keyed by the notice's subjectKey). Never throws: Home renders without it.
 */
export async function loadModelUpgradeNotice(userId: string, teamId: string): Promise<ModelUpgradeNotice | null> {
  try {
    const notice = buildModelUpgradeNotice(await buildAdoptionReport(teamId, null));
    if (!notice) return null;
    const snoozed = await db.query.actionQueueSnoozes.findFirst({
      where: and(
        eq(actionQueueSnoozes.userId, userId),
        eq(actionQueueSnoozes.subjectKey, notice.subjectKey),
        gt(actionQueueSnoozes.snoozedUntil, new Date()),
      ),
      columns: { subjectKey: true },
    });
    return snoozed ? null : notice;
  } catch {
    return null;
  }
}
