import { db } from '@buildd/core/db';
import { darkCheckAlerts, workspaces } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { notify } from '@/lib/pushover';
import { githubApi } from '@/lib/github';
import { triggerEvent, channels } from '@/lib/pusher';
import { workspaceRepoMatches } from '@/lib/repo-scope';

const DEFAULT_THRESHOLD = 5;
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

interface DarkCheckParams {
  workspaceId: string;
  workspaceName: string;
  installationId: number;
  repoFullName: string;
  headSha: string;
  threshold?: number;
}

/**
 * Detects required CI checks that consistently report 'skipped' — a dark-check
 * pattern where a misconfigured check silently bypasses required CI gates.
 *
 * Fires a Pushover alert when the same check has been skipped on N consecutive
 * closed/merged PRs (default N=5). Deduplicates alerts to once per 24h per
 * (workspace, checkName) pair. Non-fatal: any error is logged, never thrown.
 */
export async function detectDarkChecks({
  workspaceId,
  workspaceName,
  installationId,
  repoFullName,
  headSha,
  threshold = DEFAULT_THRESHOLD,
}: DarkCheckParams): Promise<void> {
  try {
    // 1. Try to get required checks from branch protection rules for 'dev'.
    //    Falls back to all check runs if branch protection is inaccessible.
    let requiredCheckNames: Set<string> | null = null;
    try {
      const [owner, repoName] = repoFullName.split('/');
      const protection = await githubApi(
        installationId,
        `/repos/${owner}/${repoName}/branches/dev/protection`,
      );
      const contexts = protection?.required_status_checks?.contexts;
      if (Array.isArray(contexts) && contexts.length > 0) {
        requiredCheckNames = new Set(contexts as string[]);
      }
    } catch {
      // Branch protection not configured or insufficient permissions — track all checks.
    }

    // 2. Fetch check runs for this PR's head SHA.
    let checkRuns: Array<{ name: string; conclusion: string | null }>;
    try {
      const data = await githubApi(
        installationId,
        `/repos/${repoFullName}/commits/${headSha}/check-runs`,
      );
      checkRuns = (data?.check_runs ?? []).map((run: { name: string; conclusion?: string | null }) => ({
        name: String(run.name),
        conclusion: run.conclusion ?? null,
      }));
    } catch (err) {
      console.warn(`[dark-check] Failed to fetch check runs for ${repoFullName}@${headSha}:`, err);
      return;
    }

    if (checkRuns.length === 0) return;

    // 3. Narrow to required checks (or all checks if branch protection unavailable).
    const checksToTrack = requiredCheckNames
      ? checkRuns.filter(r => requiredCheckNames!.has(r.name))
      : checkRuns;

    if (checksToTrack.length === 0) return;

    const now = new Date();

    // 4. Update consecutive-skip counters per check name.
    for (const check of checksToTrack) {
      const isSkipped = check.conclusion === 'skipped' || check.conclusion === null;

      const existing = await db.query.darkCheckAlerts.findFirst({
        where: and(
          eq(darkCheckAlerts.workspaceId, workspaceId),
          eq(darkCheckAlerts.checkName, check.name),
        ),
      });

      const newCount = isSkipped ? (existing?.consecutiveSkips ?? 0) + 1 : 0;

      if (existing) {
        await db
          .update(darkCheckAlerts)
          .set({ consecutiveSkips: newCount, updatedAt: now })
          .where(
            and(
              eq(darkCheckAlerts.workspaceId, workspaceId),
              eq(darkCheckAlerts.checkName, check.name),
            ),
          );
      } else {
        await db.insert(darkCheckAlerts).values({
          workspaceId,
          checkName: check.name,
          consecutiveSkips: newCount,
          updatedAt: now,
        });
      }

      // 5. Alert if threshold reached and not recently alerted (24h dedup).
      if (newCount >= threshold) {
        const lastAlerted = existing?.lastAlertedAt;
        const shouldAlert =
          !lastAlerted || now.getTime() - lastAlerted.getTime() > DEDUP_WINDOW_MS;

        if (shouldAlert) {
          // Stamp lastAlertedAt before firing to prevent concurrent duplicate alerts.
          await db
            .update(darkCheckAlerts)
            .set({ lastAlertedAt: now, updatedAt: now })
            .where(
              and(
                eq(darkCheckAlerts.workspaceId, workspaceId),
                eq(darkCheckAlerts.checkName, check.name),
              ),
            );

          notify({
            app: 'alerts',
            title: `Dark check detected — ${workspaceName}`,
            message: `Required check '${check.name}' has been Skipped on ${newCount} consecutive PRs — may be misconfigured.`,
            priority: 0,
          });

          // Emit workspace event so it surfaces in real-time dashboard feed.
          triggerEvent(channels.workspace(workspaceId), 'workspace:dark_check_detected', {
            workspaceId,
            checkName: check.name,
            consecutiveSkips: newCount,
          }).catch(e => console.error('[dark-check] Pusher event failed:', e));

          console.log(
            `[dark-check] Alert fired: workspace=${workspaceId} check="${check.name}" consecutiveSkips=${newCount}`,
          );
        }
      }
    }
  } catch (err) {
    console.error('[dark-check] detectDarkChecks failed (non-fatal):', err);
  }
}

/**
 * Entry point called from the GitHub webhook on PR close/merge. Looks up the
 * workspace for the repo and delegates to detectDarkChecks.
 */
export async function detectDarkChecksForClosedPr(
  installationId: number,
  repoFullName: string,
  headSha: string,
): Promise<void> {
  const workspace = await db.query.workspaces.findFirst({
    where: workspaceRepoMatches(repoFullName),
    columns: { id: true, name: true },
  });
  if (!workspace) return;

  await detectDarkChecks({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    installationId,
    repoFullName,
    headSha,
  });
}
