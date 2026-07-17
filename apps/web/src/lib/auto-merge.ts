/**
 * Shared auto-merge helpers.
 *
 * Used by:
 *   - apps/web/src/app/api/github/webhook/route.ts (CI-green + no-CI paths)
 *   - apps/web/src/app/api/workers/[id]/route.ts   (reviewer approve path)
 */

import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { githubApi, mergePullRequest } from '@/lib/github';
import { notifyMissionPrReady } from '@/lib/mission-notifications';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';

const DEFAULT_AUTO_MERGE_MAX_LINES = 800;

/**
 * Check CI status, deny paths, and diff size for a PR before merging.
 * Returns `{ ok: true }` when all safety rails pass, `{ ok: false, reason }` otherwise.
 */
export async function evaluateAutoMergeSafety(
  installationId: number,
  repoFullName: string,
  prNumber: number,
  headSha: string,
  gitConfig: { autoMergeDenyPaths?: string[]; autoMergeMaxLines?: number } | null | undefined,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // CI completeness check — verify no check runs are still pending or failing.
  try {
    const checkRunsData = await githubApi(
      installationId,
      `/repos/${repoFullName}/commits/${headSha}/check-runs`,
    );
    const checkRuns: Array<{ name: string; status: string; conclusion: string | null }> =
      checkRunsData?.check_runs ?? [];

    const pendingOrFailed = checkRuns.filter(
      (r) => r.status === 'in_progress' || r.status === 'queued' || r.conclusion === 'failure',
    );
    if (pendingOrFailed.length > 0) {
      return {
        ok: false,
        reason: `CI checks still pending or failed: ${pendingOrFailed.map((r) => r.name).join(', ')}`,
      };
    }

    // Warn if expected named checks are absent — likely means no test suite is configured.
    const runNames = checkRuns.map((r) => r.name.toLowerCase());
    const missingChecks = ['typecheck', 'build', 'test'].filter(
      (c) => !runNames.some((n) => n.includes(c)),
    );
    if (missingChecks.length > 0) {
      console.warn(
        `${repoFullName}#${prNumber}: expected CI checks not found (${missingChecks.join(', ')}) — no test suite configured?`,
      );
    }
  } catch (err) {
    console.warn(`Could not verify check runs for ${repoFullName}@${headSha}:`, err);
  }

  const denyPaths = gitConfig?.autoMergeDenyPaths ?? [];
  const maxLines = gitConfig?.autoMergeMaxLines ?? DEFAULT_AUTO_MERGE_MAX_LINES;

  let files: Array<{ filename: string; additions: number; deletions: number }> = [];
  try {
    files = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}/files?per_page=300`);
  } catch (err) {
    return { ok: false, reason: `could not fetch PR files: ${err instanceof Error ? err.message : 'unknown'}` };
  }
  if (!Array.isArray(files)) {
    return { ok: false, reason: 'malformed PR files response' };
  }

  if (denyPaths.length > 0) {
    const hit = files.find((f) => denyPaths.some((p) => f.filename.startsWith(p)));
    if (hit) {
      return { ok: false, reason: `touches protected path (${hit.filename})` };
    }
  }

  const NOISE_PATTERNS = [/^packages\/core\/drizzle\/meta\//, /\.lock$/, /^bun\.lockb$/];
  const sourceFiles = files.filter((f) => !NOISE_PATTERNS.some((p) => p.test(f.filename)));
  const totalLines = sourceFiles.reduce((sum, f) => sum + (f.additions || 0) + (f.deletions || 0), 0);
  if (totalLines > maxLines) {
    return {
      ok: false,
      reason: `diff size ${totalLines} source lines > limit ${maxLines} (${files.length - sourceFiles.length} noise files excluded)`,
    };
  }

  return { ok: true };
}

/**
 * Enforce safety rails, then squash-merge the PR.
 * On a rail violation, notify the mission feed instead of merging.
 */
export async function tryAutoMergeWorkerPr(params: {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  worker: { id: string; taskId: string | null };
  gitConfig: WorkspaceGitConfig | null | undefined;
}): Promise<void> {
  const { installationId, repoFullName, prNumber, headSha, worker, gitConfig } = params;

  const safetyCheck = await evaluateAutoMergeSafety(installationId, repoFullName, prNumber, headSha, gitConfig);
  if (!safetyCheck.ok) {
    console.log(`Auto-merge blocked for ${repoFullName}#${prNumber}: ${safetyCheck.reason}`);
    if (worker.taskId) {
      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, worker.taskId),
        columns: { missionId: true, title: true },
      });
      if (task?.missionId) {
        await notifyMissionPrReady(task.missionId, {
          title: 'Auto-merge blocked — review needed',
          prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
          prNumber,
          headSha,
          reason: 'auto_merge_blocked',
          message: `${task.title} — ${safetyCheck.reason}`,
        });
      }
    }
    return;
  }

  const result = await mergePullRequest(installationId, repoFullName, prNumber, 'squash');
  if (result.merged) {
    console.log(`Auto-merged PR #${prNumber} on ${repoFullName} for worker ${worker.id}`);
  } else {
    console.warn(`Failed to auto-merge PR #${prNumber} on ${repoFullName}: ${result.message}`);
  }
}
