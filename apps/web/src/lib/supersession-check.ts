/**
 * Supersession precheck for conflict-retry dispatch.
 *
 * Runs BEFORE each conflict-resolution attempt. If the checks indicate that the
 * PR's changes have already landed in base via a different route, the retry chain
 * is halted and an escalation is raised instead of burning the attempt.
 *
 * Two independent detectors:
 * 1. Drift ratio (fast heuristic): compare recorded worker diff stats vs live
 *    GitHub PR stats. A ratio ≥ threshold means base drift dominates the PR.
 * 2. Content-already-upstream (authoritative): GitHub compare shows the PR branch
 *    has no net diff vs its base — all changes already applied upstream.
 *
 * Both detectors must fire to escalate, eliminating false positives from large
 * conflict-resolution merge commits.
 */

import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, eq, ne, inArray } from 'drizzle-orm';

export const DEFAULT_SUPERSESSION_DRIFT_RATIO = 10;

// ── Types ────────────────────────────────────────────────────────────────────

export interface DiffStats {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface SupersessionResult {
  /** True when both detectors fired — retry should be halted. */
  superseded: boolean;
  /** Which detectors fired. */
  signals: Array<'drift_ratio' | 'content_upstream'>;
  /** Lines ratio (live / recorded). Undefined when recorded total is 0. */
  driftRatioLines?: number;
  /** File count ratio (live / recorded). Undefined when recorded total is 0. */
  driftRatioFiles?: number;
  /** Merged PR number that appears to have landed the same change, if found. */
  successorPrNumber?: number | null;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Returns true when the live GitHub diff is at least `threshold` times larger
 * than the recorded stats on either line count or file count.
 *
 * Skips the check when recorded totals are 0 (nothing committed yet).
 * File ratio requires liveFiles > 1 to avoid 0→1 false positives.
 */
export function checkDriftRatio(
  recorded: DiffStats,
  live: DiffStats,
  threshold: number,
): boolean {
  const recordedLines = recorded.linesAdded + recorded.linesRemoved;
  const liveLines = live.linesAdded + live.linesRemoved;
  if (recordedLines > 0 && liveLines / recordedLines >= threshold) return true;

  const recordedFiles = recorded.filesChanged;
  const liveFiles = live.filesChanged;
  if (recordedFiles > 0 && liveFiles > 1 && liveFiles / recordedFiles >= threshold) return true;

  return false;
}

// ── GitHub API checks ─────────────────────────────────────────────────────────

/**
 * Fetch live PR diff stats from GitHub.
 * Returns null on failure — treat as no-signal for the drift check.
 */
export async function fetchLivePrStats(
  installationId: number,
  repoFullName: string,
  prNumber: number,
): Promise<DiffStats | null> {
  try {
    const { githubApi } = await import('@/lib/github');
    const pr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
    if (!pr) return null;
    return {
      filesChanged: pr.changed_files ?? 0,
      linesAdded: pr.additions ?? 0,
      linesRemoved: pr.deletions ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Returns true when the PR branch has no net diff vs its base branch.
 *
 * Uses `GET /repos/{owner}/{repo}/compare/{base}...{head}`:
 * - `ahead_by === 0`: branch has no unique commits → fully superseded.
 * - `files.length === 0` with `ahead_by > 0`: commits exist but produce no diff
 *   (squash-merged or cherry-picked upstream) → content already upstream.
 *
 * Returns null on GitHub API failure — treat as no-signal.
 */
export async function checkContentAlreadyUpstream(
  installationId: number,
  repoFullName: string,
  prNumber: number,
): Promise<boolean | null> {
  try {
    const { githubApi } = await import('@/lib/github');
    const pr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
    if (!pr) return null;

    const baseBranch: string = pr.base?.ref;
    const headSha: string = pr.head?.sha;
    if (!baseBranch || !headSha) return null;

    const compare = await githubApi(
      installationId,
      `/repos/${repoFullName}/compare/${baseBranch}...${headSha}`,
    );
    if (!compare) return null;

    const aheadBy: number = compare.ahead_by ?? 0;
    const changedFiles: number = compare.files?.length ?? 0;

    // No unique commits
    if (aheadBy === 0) return true;

    // Unique commits but no net diff → squash-merged / cherry-picked upstream
    if (changedFiles === 0) return true;

    return false;
  } catch {
    return null;
  }
}

// ── Successor discovery ───────────────────────────────────────────────────────

/**
 * Find the PR number that appears to have landed the same change.
 *
 * Strategy: look for workers in the same workspace whose merged PR is different
 * from `prNumber` and whose task shares the same subject PR anchor as the root
 * of the current task chain.
 *
 * Returns null when no obvious successor is found.
 */
export async function findSuccessorPr(
  workspaceId: string,
  taskId: string,
  prNumber: number,
): Promise<number | null> {
  // Walk up to find the root task (the original, non-retry task)
  let rootTaskId = taskId;
  for (let depth = 0; depth < 6; depth++) {
    const t = await db.query.tasks.findFirst({
      where: eq(tasks.id, rootTaskId),
      columns: { parentTaskId: true, subjectPrNumber: true },
    });
    if (!t?.parentTaskId) break;
    rootTaskId = t.parentTaskId;
  }

  // Get the root task's subject PR number
  const rootTask = await db.query.tasks.findFirst({
    where: eq(tasks.id, rootTaskId),
    columns: { subjectPrNumber: true },
  });
  const subjectPrNumber = rootTask?.subjectPrNumber ?? null;

  if (!subjectPrNumber) return null;

  // Find sibling tasks that share the same subject anchor
  const siblings = await db.query.tasks.findMany({
    where: and(
      eq(tasks.workspaceId, workspaceId),
      eq(tasks.subjectPrNumber, subjectPrNumber),
    ),
    columns: { id: true },
  });

  const siblingIds = siblings.map(s => s.id).filter(id => id !== rootTaskId);
  if (siblingIds.length === 0) return null;

  // Find merged workers for those tasks whose PR ≠ the conflicted PR
  const mergedWorker = await db.query.workers.findFirst({
    where: and(
      eq(workers.workspaceId, workspaceId),
      inArray(workers.taskId, siblingIds),
      eq(workers.prLifecycleStatus, 'merged'),
      ne(workers.prNumber, prNumber),
    ),
    columns: { prNumber: true },
    orderBy: (w, { desc }) => [desc(w.mergedAt)],
  });

  return mergedWorker?.prNumber ?? null;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export interface RunSupersessionPrecheckParams {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  /** Diff stats recorded by the worker when it last committed. */
  recordedStats: DiffStats;
  /** Ratio threshold for the drift detector (default 10). */
  driftRatioThreshold?: number;
  /** Workspace + task IDs for successor search. */
  workspaceId: string;
  taskId: string;
}

/**
 * Run both supersession detectors.
 *
 * Returns `{ superseded: true }` only when BOTH the drift-ratio heuristic AND
 * the authoritative content-already-upstream check fire together. This two-gate
 * requirement prevents false positives from large conflict-resolution commits.
 *
 * On any GitHub API failure, the affected detector returns no-signal and the
 * check passes (fail-open — do not block retries on API flakiness).
 */
export async function runSupersessionPrecheck(
  params: RunSupersessionPrecheckParams,
): Promise<SupersessionResult> {
  const {
    installationId,
    repoFullName,
    prNumber,
    recordedStats,
    driftRatioThreshold = DEFAULT_SUPERSESSION_DRIFT_RATIO,
    workspaceId,
    taskId,
  } = params;

  const signals: Array<'drift_ratio' | 'content_upstream'> = [];
  let driftRatioLines: number | undefined;
  let driftRatioFiles: number | undefined;

  // ── 1. Drift ratio (fast heuristic) ──────────────────────────────────────
  const liveStats = await fetchLivePrStats(installationId, repoFullName, prNumber);

  if (liveStats) {
    const recordedLines = recordedStats.linesAdded + recordedStats.linesRemoved;
    const liveLines = liveStats.linesAdded + liveStats.linesRemoved;
    if (recordedLines > 0) driftRatioLines = liveLines / recordedLines;
    if (recordedStats.filesChanged > 0) driftRatioFiles = liveStats.filesChanged / recordedStats.filesChanged;

    if (checkDriftRatio(recordedStats, liveStats, driftRatioThreshold)) {
      signals.push('drift_ratio');
    }
  }

  // ── 2. Content-already-upstream (authoritative) ───────────────────────────
  const upstream = await checkContentAlreadyUpstream(installationId, repoFullName, prNumber);
  if (upstream === true) {
    signals.push('content_upstream');
  }

  // Both gates must fire to conclude supersession
  const superseded = signals.includes('drift_ratio') && signals.includes('content_upstream');

  // Only do the successor search when superseded
  let successorPrNumber: number | null | undefined;
  if (superseded) {
    successorPrNumber = await findSuccessorPr(workspaceId, taskId, prNumber).catch(() => null);
  }

  return { superseded, signals, driftRatioLines, driftRatioFiles, successorPrNumber };
}
