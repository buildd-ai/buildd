import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import { eq, and, isNull, or, ne } from 'drizzle-orm';
import { notify } from '@/lib/pushover';

/**
 * Push a "mission PR needs attention" notification, deduped by head SHA.
 *
 * Writes the SHA to missions.lastNotifiedSha in the same UPDATE that guards
 * against duplicates, so concurrent callers only produce one notification per SHA.
 */
export async function notifyMissionPrReady(
  missionId: string,
  opts: {
    title: string;
    prUrl: string;
    prNumber: number;
    headSha: string;
    reason: 'pr_open' | 'auto_merge_blocked' | 'awaiting_review' | 'ci_failed';
    message: string;
  },
): Promise<{ notified: boolean }> {
  const [claimed] = await db
    .update(missions)
    .set({ lastNotifiedSha: opts.headSha, updatedAt: new Date() })
    .where(
      and(
        eq(missions.id, missionId),
        or(
          isNull(missions.lastNotifiedSha),
          ne(missions.lastNotifiedSha, opts.headSha),
        ),
      ),
    )
    .returning({ id: missions.id });

  if (!claimed) {
    return { notified: false };
  }

  notify({
    app: 'tasks',
    title: opts.title,
    message: opts.message,
    url: opts.prUrl,
    urlTitle: `Review PR #${opts.prNumber}`,
    priority: (opts.reason === 'auto_merge_blocked' || opts.reason === 'ci_failed') ? 0 : -1,
  });

  return { notified: true };
}
