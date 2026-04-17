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
    reason: 'pr_open' | 'auto_merge_blocked' | 'awaiting_review';
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
    priority: opts.reason === 'auto_merge_blocked' ? 0 : -1,
  });

  return { notified: true };
}

/**
 * Fetch current PR state (open/merged/mergeable) for a mission's primary PR.
 * Returns null if the mission has no recorded PR or the fetch failed.
 */
export async function getMissionPrState(
  missionId: string,
  githubApi: (installationId: number, path: string, init?: RequestInit) => Promise<any>,
): Promise<{
  prNumber: number;
  prUrl: string;
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
  mergeable: boolean | null;
  installationId: number;
  repoFullName: string;
} | null> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { primaryPrNumber: true, primaryPrUrl: true, workspaceId: true },
    with: {
      workspace: {
        with: { githubRepo: { with: { installation: true } } },
      },
    },
  });

  if (!mission?.primaryPrNumber || !mission.primaryPrUrl) return null;
  const installationId = mission.workspace?.githubRepo?.installation?.installationId;
  const repoFullName = mission.workspace?.githubRepo?.fullName;
  if (!installationId || !repoFullName) return null;

  try {
    const pr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${mission.primaryPrNumber}`);
    return {
      prNumber: mission.primaryPrNumber,
      prUrl: mission.primaryPrUrl,
      state: pr.state,
      merged: !!pr.merged,
      headSha: pr.head?.sha ?? '',
      mergeable: pr.mergeable ?? null,
      installationId,
      repoFullName,
    };
  } catch {
    return null;
  }
}
