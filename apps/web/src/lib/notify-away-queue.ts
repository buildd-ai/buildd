/**
 * The Redis due-queue in front of away delivery (lib/away-delivery.ts,
 * /api/cron/notify-away). Kept tiny and dependency-free so recordEvent can
 * publish to it without pulling the delivery code into every emit site.
 */

export const AWAY_QUEUE = 'notify-away';
/** A burst inside this window becomes one push. */
export const COALESCE_MS = 60_000;

/**
 * Mark new ledger rows due at created + COALESCE_MS (urgent: now). Never
 * throws and never blocks on a missing Redis: the cron's floor tick covers a
 * lost write.
 */
export async function markAwayDue(rows: Array<{ id: string }>, urgency: 'low' | 'normal' | 'urgent', now: Date): Promise<void> {
  if (rows.length === 0) return;
  try {
    const { markDue } = await import('./redis');
    const dueAt = now.getTime() + (urgency === 'urgent' ? 0 : COALESCE_MS);
    await Promise.all(rows.map(r => markDue(AWAY_QUEUE, r.id, dueAt)));
  } catch {
    // Best effort by design.
  }
}
