/**
 * Dead-PR shutdown — task 6/7 of the subject-anchors mission.
 *
 * When a buildd-authored PR closes or merges, scan the same workspace for
 * other buildd-authored open PRs whose tasks share the same subject anchor.
 * Apply one of three tiers:
 *
 *   1. Closed/superseded: the winner PR merged → immediately close the loser.
 *   2. Conflict-dead + green winner: loser has been in conflict for
 *      ≥ conflictDeadDays and the winner is green → close the loser.
 *   3. Conflict-dead, no winner: create or update one escalation note; do
 *      not close — a human must decide.
 *
 * Ships behind `autoCloseBuilddSupersededPrs: false` (workspace subjectPolicy).
 * Default OFF for all teams — callers must check the flag before calling this.
 *
 * Ownership boundary: a PR is only eligible for auto-close when a buildd
 * worker record exists for it (workers.prNumber). That record IS the proof of
 * buildd authorship; no additional GitHub API call is made for ownership.
 *
 * Closure ordering (per spec §5):
 *   1. Verify ownership, successor identity, and tier.
 *   2. Post successor comment (idempotent — marker in comment body).
 *   3. Close via GitHub API.
 *   4. Stamp worker prLifecycleStatus = 'closed' (only after GitHub succeeds).
 *   5. Supersede open escalation notes.
 *   6. Subject sweep (already handled by caller, but called here for losers too).
 *
 * If GitHub closure fails: keep PR open, keep escalation open, do NOT stamp.
 */

import { db } from '@buildd/core/db';
import {
  missionNotes,
  tasks,
  workers,
  workspaces,
  githubInstallations,
} from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull, ne, not, or, isNull } from 'drizzle-orm';
import { resolveSubjectPolicy } from '@buildd/core/subject-anchor-observe';
import { sweepSubjectAnchoredTasks } from './subject-sweep';

// ── Types ────────────────────────────────────────────────────────────────────

export interface LoserCandidate {
  workerId: string;
  taskId: string;
  prNumber: number;
  branch: string;
  prLifecycleStatus: string | null;
  conflictDetectedAt: Date | null;
  missionId: string | null;
  workspaceId: string;
}

export interface ShutdownResult {
  closedPrNumbers: number[];
  escalatedPrNumbers: number[];
  skippedPrNumbers: number[];
}

// ── GitHub API helpers ────────────────────────────────────────────────────────

// Lazily imported so tests can mock without the full github module.
async function getGithubApi() {
  const { githubApi } = await import('@/lib/github');
  return { githubApi };
}

const SHUTDOWN_COMMENT_MARKER = '<!-- buildd-dead-pr-shutdown -->';

async function postSuccessorComment(
  installationId: number,
  repoFullName: string,
  loserPrNumber: number,
  successorPrNumber: number,
): Promise<void> {
  const { githubApi } = await getGithubApi();
  const body =
    `${SHUTDOWN_COMMENT_MARKER}\n` +
    `This pull request has been superseded by #${successorPrNumber} and is being ` +
    `automatically closed by buildd. See [PR #${successorPrNumber}](https://github.com/${repoFullName}/pull/${successorPrNumber}) ` +
    `for the current work.`;
  await githubApi(installationId, `/repos/${repoFullName}/issues/${loserPrNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function closePullRequestOnGitHub(
  installationId: number,
  repoFullName: string,
  prNumber: number,
): Promise<void> {
  const { githubApi } = await getGithubApi();
  await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed' }),
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Escalation helpers ────────────────────────────────────────────────────────

const ESCALATION_TITLE_PREFIX = '[subject-anchor] conflict-dead PR #';

function escalationTitle(loserPrNumber: number): string {
  return `${ESCALATION_TITLE_PREFIX}${loserPrNumber}: no green successor, human action required`;
}

async function upsertConflictEscalation(loser: LoserCandidate): Promise<void> {
  if (!loser.missionId && !loser.taskId) return;

  const title = escalationTitle(loser.prNumber);

  // Check for an existing open escalation for this loser PR
  const existing = await db.query.missionNotes.findFirst({
    where: and(
      loser.missionId ? eq(missionNotes.missionId, loser.missionId) : isNull(missionNotes.missionId),
      eq(missionNotes.taskId, loser.taskId),
      eq(missionNotes.type, 'warning'),
      eq(missionNotes.status, 'open'),
      eq(missionNotes.title, title),
    ),
    columns: { id: true },
  });

  if (existing) {
    // Already escalated — update body to refresh the timestamp context
    await db
      .update(missionNotes)
      .set({ body: `PR #${loser.prNumber} has merge conflicts and no green successor. Conflict detected at: ${loser.conflictDetectedAt?.toISOString() ?? 'unknown'}. Human action required: rebase, abandon, or designate a successor.` })
      .where(eq(missionNotes.id, existing.id));
    return;
  }

  await db.insert(missionNotes).values({
    missionId: loser.missionId,
    taskId: loser.taskId,
    workerId: loser.workerId,
    authorType: 'system',
    type: 'warning',
    title,
    body: `PR #${loser.prNumber} has merge conflicts and no green successor. Conflict detected at: ${loser.conflictDetectedAt?.toISOString() ?? 'unknown'}. Human action required: rebase, abandon, or designate a successor.`,
    status: 'open',
  });
}

async function supersedePrEscalations(
  taskId: string,
  successorPrNumber: number,
): Promise<void> {
  await db
    .update(missionNotes)
    .set({ status: 'superseded', supersededByPrNumber: successorPrNumber })
    .where(
      and(
        eq(missionNotes.taskId, taskId),
        eq(missionNotes.status, 'open'),
        eq(missionNotes.type, 'warning'),
      ),
    );
}

// ── Tier logic ────────────────────────────────────────────────────────────────

function isTier1Eligible(loser: LoserCandidate): boolean {
  // Tier 1: winner merged → close immediately (non-conflict supersession).
  // Conflict-dead PRs go through Tier 2 or 3 so the conflictDeadDays guard applies.
  return (
    loser.prLifecycleStatus !== 'closed' &&
    loser.prLifecycleStatus !== 'merged' &&
    loser.prLifecycleStatus !== 'conflict'
  );
}

function isTier2Eligible(loser: LoserCandidate, conflictDeadDays: number): boolean {
  // Tier 2: conflict-dead for ≥ conflictDeadDays with a green winner.
  if (loser.prLifecycleStatus !== 'conflict') return false;
  if (!loser.conflictDetectedAt) return false;
  const ageMs = Date.now() - loser.conflictDetectedAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays >= conflictDeadDays;
}

function isTier3Eligible(loser: LoserCandidate): boolean {
  // Tier 3: in conflict with no green successor.
  return loser.prLifecycleStatus === 'conflict';
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Find and shut down dead buildd-authored PRs after a PR close/merge event.
 *
 * @param workspaceId   The workspace the triggering PR belongs to.
 * @param eventPrNumber The PR number that was just closed or merged.
 * @param eventMerged   True when the PR was successfully merged (winner); false when abandoned.
 * @param installationId GitHub App installation ID for API calls.
 * @param repoFullName  "owner/repo" string for GitHub API calls.
 */
export async function shutdownDeadBuilddPrs(
  workspaceId: string,
  eventPrNumber: number,
  eventMerged: boolean,
  installationId: number,
  repoFullName: string,
): Promise<ShutdownResult> {
  const result: ShutdownResult = {
    closedPrNumbers: [],
    escalatedPrNumbers: [],
    skippedPrNumbers: [],
  };

  // ── 1. Check feature flag ────────────────────────────────────────────────

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { gitConfig: true },
  });
  const policy = resolveSubjectPolicy(workspace?.gitConfig?.subjectPolicy);
  if (!policy.autoCloseBuilddSupersededPrs) {
    return result; // Feature disabled for this workspace
  }

  // ── 2. Find the event worker and its task's subject PR ──────────────────

  const eventWorker = await db.query.workers.findFirst({
    where: and(
      eq(workers.workspaceId, workspaceId),
      eq(workers.prNumber, eventPrNumber),
    ),
    columns: { id: true, taskId: true },
  });
  if (!eventWorker?.taskId) return result;

  const eventTask = await db.query.tasks.findFirst({
    where: eq(tasks.id, eventWorker.taskId),
    columns: { subjectPrNumber: true },
  });
  if (!eventTask?.subjectPrNumber) return result;

  const subjectPrNumber = eventTask.subjectPrNumber;

  // ── 3. Find loser candidates ─────────────────────────────────────────────

  // A loser is a worker in this workspace with an open PR (not the event PR)
  // whose task anchors to the same subject PR.
  const loserTasks = await db.query.tasks.findMany({
    where: and(
      eq(tasks.workspaceId, workspaceId),
      eq(tasks.subjectPrNumber, subjectPrNumber),
      ne(tasks.id, eventWorker.taskId),
    ),
    columns: { id: true, missionId: true },
  });

  if (loserTasks.length === 0) return result;

  const loserTaskIds = loserTasks.map(t => t.id);
  const missionById = Object.fromEntries(loserTasks.map(t => [t.id, t.missionId]));

  const loserWorkers = await db.query.workers.findMany({
    where: and(
      inArray(workers.taskId, loserTaskIds),
      isNotNull(workers.prNumber),
      // Include workers whose prLifecycleStatus is null OR not 'closed'/'merged'.
      // SQL NOT IN excludes NULLs, so we guard with an OR IS NULL.
      or(
        isNull(workers.prLifecycleStatus),
        not(inArray(workers.prLifecycleStatus as any, ['closed', 'merged'])),
      ),
    ),
    columns: {
      id: true,
      taskId: true,
      prNumber: true,
      branch: true,
      prLifecycleStatus: true,
      conflictDetectedAt: true,
      workspaceId: true,
    },
  });

  if (loserWorkers.length === 0) return result;

  const losers: LoserCandidate[] = loserWorkers
    .filter(w => w.prNumber !== null && w.prNumber !== eventPrNumber)
    .map(w => ({
      workerId: w.id,
      taskId: w.taskId!,
      prNumber: w.prNumber!,
      branch: w.branch,
      prLifecycleStatus: w.prLifecycleStatus,
      conflictDetectedAt: w.conflictDetectedAt,
      missionId: missionById[w.taskId!] ?? null,
      workspaceId: w.workspaceId,
    }));

  // ── 4. Apply tier logic to each loser ────────────────────────────────────

  for (const loser of losers) {
    try {
      if (eventMerged && isTier1Eligible(loser)) {
        // Tier 1: winner merged → immediately close loser
        await closePrWithComment(loser, eventPrNumber, installationId, repoFullName);
        result.closedPrNumbers.push(loser.prNumber);
      } else if (eventMerged && isTier2Eligible(loser, policy.conflictDeadDays)) {
        // Tier 2: conflict-dead ≥ conflictDeadDays with green winner → close
        await closePrWithComment(loser, eventPrNumber, installationId, repoFullName);
        result.closedPrNumbers.push(loser.prNumber);
      } else if (isTier3Eligible(loser)) {
        // Tier 3: conflict-dead, no green winner → escalate, do not close
        await upsertConflictEscalation(loser);
        result.escalatedPrNumbers.push(loser.prNumber);
      } else {
        result.skippedPrNumbers.push(loser.prNumber);
      }
    } catch (err) {
      console.error(`[dead-pr-shutdown] failed to process loser PR #${loser.prNumber}:`, err);
      result.skippedPrNumbers.push(loser.prNumber);
    }
  }

  return result;
}

/**
 * Close a loser PR on GitHub, stamp the worker, and supersede open escalations.
 * If GitHub close fails, nothing is stamped (no optimistic update).
 */
async function closePrWithComment(
  loser: LoserCandidate,
  successorPrNumber: number,
  installationId: number,
  repoFullName: string,
): Promise<void> {
  // Step 2 of spec §5: post comment (idempotent — marker prevents duplicates)
  try {
    await postSuccessorComment(installationId, repoFullName, loser.prNumber, successorPrNumber);
  } catch (err) {
    // Non-fatal: comment failure doesn't stop the close
    console.warn(`[dead-pr-shutdown] comment on PR #${loser.prNumber} failed:`, err);
  }

  // Step 3 of spec §5: close through GitHub
  await closePullRequestOnGitHub(installationId, repoFullName, loser.prNumber);
  // If the above throws, we do NOT stamp closed (let it propagate)

  // Step 4 of spec §5: stamp worker lifecycle
  await db
    .update(workers)
    .set({ prLifecycleStatus: 'closed', updatedAt: new Date() })
    .where(eq(workers.id, loser.workerId));

  // Step 5 of spec §5: supersede open escalations
  await supersedePrEscalations(loser.taskId, successorPrNumber);

  // Step 6 of spec §5: subject sweep (best-effort)
  sweepSubjectAnchoredTasks(loser.workspaceId, loser.prNumber).catch(e =>
    console.error(`[dead-pr-shutdown] subject sweep failed for PR #${loser.prNumber}:`, e),
  );

  console.log(
    `[dead-pr-shutdown] closed loser PR #${loser.prNumber} (superseded by #${successorPrNumber})`,
  );
}
