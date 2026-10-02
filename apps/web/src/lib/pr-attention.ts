/**
 * Which open PRs need a person, and which an agent is already on — the
 * decision behind the escalation inbox (GET /api/prs/escalation-inbox), shared
 * with the PR list (lib/pr-list.ts) so the two can't disagree.
 *
 * Moved verbatim from the inbox route: a PR is in the inbox when a reviewer
 * escalated it, approved it under an approve-only gate, when conflict retries
 * are exhausted, when a conflict retry is running (shown as resolving), or when
 * the merge policy tier is human. A PR under a live agent-review lease is not.
 */
import { db } from '@buildd/core/db';
import { workers, tasks, workspaces, missionNotes } from '@buildd/core/db/schema';
import { eq, and, inArray, isNotNull, isNull, sql, desc } from 'drizzle-orm';
import { resolvePolicy } from '@/lib/merge-policy';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import { selectReviewerEvidence } from '@/lib/reviewer-evidence';
import { policyValue } from '@/lib/policy-overrides';

type WorkspacePolicyRow = Parameters<typeof resolvePolicy>[0] & { id: string; name: string };

export type OpenPrWorker = Awaited<ReturnType<typeof loadOpenPrWorkers>>[number];

function loadOpenPrWorkers(wsIds: string[], opts: { workerIds?: string[] }) {
  return db.query.workers.findMany({
    where: and(
      inArray(workers.workspaceId, wsIds),
      ...(opts.workerIds ? [inArray(workers.id, opts.workerIds)] : []),
      isNotNull(workers.prUrl),
      isNull(workers.mergedAt),
      sql`COALESCE(${workers.prLifecycleStatus}, 'pr_open') NOT IN ('closed', 'merged', 'unresolvable')`,
    ),
    columns: {
      id: true, taskId: true, workspaceId: true, prUrl: true, prNumber: true,
      // prBaseRef: where the PR points; a mission-branch PR is not a human's to merge.
      prLifecycleStatus: true, completedAt: true, prBaseRef: true,
    },
    with: {
      task: {
        columns: { id: true, title: true, missionId: true, status: true },
        // Only the two Option A' fields: more would feed other steps of
        // resolvePolicy's precedence chain into this call site.
        with: { mission: { columns: { workingBranch: true, integrationBranchEnabled: true } } },
      },
    },
  });
}

export interface PrAttention {
  openPrWorkers: OpenPrWorker[];
  isInInbox: (w: OpenPrWorker) => boolean;
  agentReviewingTaskIds: Set<string>;
  escalationMap: ReturnType<typeof selectReviewerEvidence>['escalationMap'];
  approvalMap: ReturnType<typeof selectReviewerEvidence>['approvalMap'];
  wsMap: Map<string, WorkspacePolicyRow>;
  conflictRetryMap: Map<string, { taskId: string; iteration: number }>;
  deadZoneExhaustedMap: Map<string, { lastRetryTaskId: string | null }>;
}

const EMPTY: PrAttention = {
  openPrWorkers: [], isInInbox: () => false, agentReviewingTaskIds: new Set(),
  escalationMap: new Map(), approvalMap: new Map(), wsMap: new Map(),
  conflictRetryMap: new Map(), deadZoneExhaustedMap: new Map(),
};

/** The open PRs in `wsIds` (optionally only these workers) and the inbox decision for each. */
export async function loadPrAttention(wsIds: string[], opts: { workerIds?: string[] } = {}): Promise<PrAttention> {
  if (wsIds.length === 0 || opts.workerIds?.length === 0) return EMPTY;
  const openPrWorkers = await loadOpenPrWorkers(wsIds, opts);
  if (openPrWorkers.length === 0) return EMPTY;
  const openTaskIds = openPrWorkers.map(w => w.taskId).filter(Boolean) as string[];

  // ── Lease detection ────────────────────────────────────────────────────────
  // Find reviewer tasks (category='review') in these workspaces that have a
  // live worker. Each reviewer task's context.reviewerFor points to the original
  // task ID — this is the lease: while such a worker is live, the PR is held.
  const reviewerLiveMap = new Map<string, { reviewerWorkerId: string; reviewerRoleSlug: string | null }>();
  if (openTaskIds.length > 0) {
    const reviewerTasksWithWorkers = await db.query.tasks.findMany({
      where: and(
        inArray(tasks.workspaceId, wsIds),
        eq(tasks.category, 'review'),
        inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
      ),
      columns: { id: true, context: true, roleSlug: true },
      with: {
        workers: {
          where: inArray(workers.status, [...LIVE_WORKER_STATUSES]),
          columns: { id: true, status: true },
          limit: 1,
        },
      },
    });

    const openTaskIdSet = new Set(openTaskIds);
    for (const rt of reviewerTasksWithWorkers) {
      const ctx = (rt.context ?? {}) as Record<string, unknown>;
      const origTaskId = ctx.reviewerFor as string | undefined;
      if (!origTaskId || !openTaskIdSet.has(origTaskId)) continue;
      const liveWorker = (rt as any).workers?.[0];
      if (liveWorker) {
        reviewerLiveMap.set(origTaskId, {
          reviewerWorkerId: liveWorker.id,
          reviewerRoleSlug: rt.roleSlug ?? null,
        });
      }
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  // Find reviewer_escalated and reviewer_approved notes for these tasks
  const allReviewerNotes = openTaskIds.length > 0
    ? await db.query.missionNotes.findMany({
        where: and(
          inArray(missionNotes.taskId, openTaskIds),
          inArray(missionNotes.type, ['reviewer_escalated', 'reviewer_approved']),
        ),
        columns: {
          taskId: true,
          type: true,
          title: true,
          body: true,
          status: true,
          supersededByPrNumber: true,
          abandonedAt: true,
          createdAt: true,
        },
      })
    : [];

  const { escalationMap, approvalMap, supersededTaskIds } =
    selectReviewerEvidence(allReviewerNotes);

  // Load workspace gitConfigs for policy detection
  const uniqueWsIds = [...new Set(openPrWorkers.map(w => w.workspaceId))];
  const workspaceRows = await db.query.workspaces.findMany({
    where: inArray(workspaces.id, uniqueWsIds),
    columns: { id: true, name: true, gitConfig: true },
  });
  const wsMap = new Map(workspaceRows.map(ws => [ws.id, ws]));

  const agentReviewingTaskIds = new Set(reviewerLiveMap.keys());

  // ── Conflict retry lease detection ────────────────────────────────────────
  // Find live conflict retry tasks. These are tasks with creationSource='conflict'
  // and a live (pending/assigned/in_progress) status keyed by (workspaceId, prNumber).
  // While such a task is live, the card renders as RESOLVING rather than asking
  // the human to act — the agent is already handling it.
  const conflictRetryMap = new Map<string, { taskId: string; iteration: number }>();
  if (openPrWorkers.length > 0) {
    const conflictRetryTasks = await db.query.tasks.findMany({
      where: and(
        inArray(tasks.workspaceId, wsIds),
        sql`${tasks.creationSource} = 'conflict'`,
        isNotNull(tasks.conflictRetryPrNumber),
        inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
      ),
      columns: { id: true, workspaceId: true, conflictRetryPrNumber: true, context: true },
    });
    for (const t of conflictRetryTasks) {
      if (t.conflictRetryPrNumber == null) continue;
      const key = `${t.workspaceId}:${t.conflictRetryPrNumber}`;
      const ctx = (t.context ?? {}) as Record<string, unknown>;
      const iteration = typeof ctx.conflictIteration === 'number' ? ctx.conflictIteration : 1;
      conflictRetryMap.set(key, { taskId: t.id, iteration });
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  // ── Dead zone exhausted detection ─────────────────────────────────────────
  // Workers where: task is terminal + PR went dirty (prLifecycleStatus='conflict')
  // + no active conflict retry + 3 retries already done → BLOCKED card.
  const deadZoneExhaustedMap = new Map<string, { lastRetryTaskId: string | null }>();

  const terminalConflictWorkers = openPrWorkers.filter(w => {
    if (w.prLifecycleStatus !== 'conflict' || w.prNumber == null) return false;
    if (conflictRetryMap.has(`${w.workspaceId}:${w.prNumber}`)) return false; // active retry running
    const taskStatus = (w.task as any)?.status as string | undefined;
    return taskStatus != null && ['completed', 'failed', 'cancelled'].includes(taskStatus);
  });

  if (terminalConflictWorkers.length > 0) {
    const tcPrNumbers = terminalConflictWorkers.map(w => w.prNumber).filter(Boolean) as number[];
    const allRetries = await db.query.tasks.findMany({
      where: and(
        inArray(tasks.workspaceId, wsIds),
        inArray(tasks.conflictRetryPrNumber, tcPrNumbers),
      ),
      columns: { id: true, workspaceId: true, conflictRetryPrNumber: true, status: true },
      orderBy: [desc(tasks.createdAt)],
    });

    for (const w of terminalConflictWorkers) {
      if (!w.prNumber) continue;
      const retries = allRetries.filter(
        t => t.workspaceId === w.workspaceId && t.conflictRetryPrNumber === w.prNumber,
      );
      const completedRetries = retries.filter(t =>
        ['completed', 'failed', 'cancelled'].includes(t.status),
      );
      if (completedRetries.length >= policyValue('maxConflictIterations')) {
        // completedRetries is sorted desc by createdAt — first = most recent
        deadZoneExhaustedMap.set(w.id, { lastRetryTaskId: completedRetries[0]?.id ?? null });
      }
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  const isInInbox = (w: OpenPrWorker): boolean => {
    if (w.prLifecycleStatus === 'closed' || w.prLifecycleStatus === 'merged') return false;
    const taskTitle = (w.task as any)?.title ?? '';
    if (taskTitle.startsWith('[smoke-test')) return false;
    if (w.taskId && supersededTaskIds.has(w.taskId)) return false;

    // Exclude items currently under an active agent-review lease
    if (w.taskId && agentReviewingTaskIds.has(w.taskId)) return false;

    // Items with a live conflict retry are included but rendered as RESOLVING
    if (w.prNumber != null && conflictRetryMap.has(`${w.workspaceId}:${w.prNumber}`)) return true;

    // Dead zone exhausted — all retries failed, PR needs human action (BLOCKED)
    if (deadZoneExhaustedMap.has(w.id)) return true;

    if (w.taskId && escalationMap.has(w.taskId)) return true;
    // Include agent-approved items (approve-only gate) so the human can merge
    if (w.taskId && approvalMap.has(w.taskId)) return true;
    const ws = wsMap.get(w.workspaceId);
    if (!ws) return false;
    // A task PR based on the mission integration branch is not a human's
    // problem — the human gate for that work is the mission PR. Keep it out of
    // the inbox. A null prBaseRef resolves exactly as before.
    const policy = resolvePolicy(
      ws,
      (w.task as any)?.mission ?? null,
      null,
      { baseRef: w.prBaseRef },
    );
    return policy.tier === 'human';
  };

  return {
    openPrWorkers, isInInbox, agentReviewingTaskIds, escalationMap, approvalMap,
    wsMap: wsMap as PrAttention['wsMap'], conflictRetryMap, deadZoneExhaustedMap,
  };
}
