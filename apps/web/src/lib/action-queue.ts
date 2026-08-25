export type ActionChip = 'MERGE' | 'BLOCKED' | 'REVIEW' | 'QUESTION' | 'APPROVE' | 'RESOLVING';

export interface ResolvedEscalationItem {
  workerId: string;
  taskId: string;
  taskTitle: string;
  prNumber: number | null;
  prUrl: string | null;
  /** Persisted lifecycle value — never re-derived from GitHub. */
  prLifecycleStatus: 'merged' | 'closed';
  workspaceName: string;
}

/**
 * Splits escalation-eligible items by lifecycle state.
 *
 * Resolution rule (§1.3 mobile-decision-flow): an item moves to resolved when
 * prLifecycleStatus is 'merged' or 'closed'. Null/unknown → treat as 'keep'
 * (item stays active). Never auto-resolve on a null lifecycle.
 */
export function partitionEscalations<T extends { prLifecycleStatus: string | null }>(
  items: T[],
): { active: T[]; resolved: T[] } {
  const active: T[] = [];
  const resolved: T[] = [];
  for (const item of items) {
    if (item.prLifecycleStatus === 'merged' || item.prLifecycleStatus === 'closed') {
      resolved.push(item);
    } else {
      active.push(item);
    }
  }
  return { active, resolved };
}

export interface WaitingOnYouRawItem {
  kind: 'merge' | 'approve' | 'answer';
  prUrl?: string;
  prNumber?: number;
  prLifecycleStatus?: 'open' | 'merged' | 'closed' | null;
  upstreamTaskId?: string;
  upstreamTaskTitle?: string;
  unblockCount?: number;
  taskId?: string;
  taskTitle?: string;
  workerId?: string;
  question?: string;
  missionId?: string | null;
  missionTitle?: string | null;
}

export interface EscalationRawItem {
  workerId: string;
  taskId: string;
  taskTitle: string;
  workspaceId: string;
  workspaceName: string;
  prNumber: number | null;
  prUrl: string | null;
  policyTier: string;
  /** Populated once a reviewer has reached a verdict. */
  leaseState?: 'agent_approved' | 'agent_flagged' | 'pending_human';
  escalationReason: string | null;
  waitingMinutes: number | null;
  /** Set when an agent is actively resolving conflicts for this PR. */
  conflictRetryTaskId?: string | null;
  conflictRetryIteration?: number | null;
  /** Set when conflict-resolution retries are exhausted — PR needs human action. */
  deadZoneExhausted?: boolean;
  /** The last conflict retry task ID — used as the CTA target on BLOCKED cards. */
  deadZoneLastRetryTaskId?: string | null;
}

export interface ActionQueueItem {
  subjectKey: string;
  // Set on Home when the item's mission belongs to an initiative — drives the
  // initiative filter chips (scoping only; buildActionQueue itself never sets it).
  initiativeId?: string | null;
  initiativeTitle?: string | null;
  chip: ActionChip;
  prUrl?: string;
  prNumber?: number;
  prLifecycleStatus?: 'open' | 'merged' | 'closed' | null;
  taskId?: string;
  taskTitle?: string;
  workspaceId?: string;
  workspaceName?: string;
  upstreamTaskTitle?: string;
  unblockCount?: number;
  missionId?: string | null;
  missionTitle?: string | null;
  waitingMinutes?: number | null;
  escalationReason?: string | null;
  workerId?: string;
  question?: string;
  /** Set when chip === 'RESOLVING' — the task actively resolving merge conflicts. */
  conflictRetryTaskId?: string | null;
  conflictRetryIteration?: number | null;
  /** Set when chip === 'BLOCKED' — retries exhausted, human decision required. */
  deadZoneExhausted?: boolean;
  /** Link target for the BLOCKED card's primary CTA. */
  deadZoneLastRetryTaskId?: string | null;
}

// Chip display order: lower index = shown first.
// BLOCKED: retries exhausted, human must decide — actionable, placed after MERGE.
// RESOLVING is last — it is informational (agent is handling it), not action-required.
const CHIP_ORDER: ActionChip[] = ['MERGE', 'BLOCKED', 'REVIEW', 'QUESTION', 'APPROVE', 'RESOLVING'];

/**
 * Merges waitingOnYou items and escalationInbox items into a single
 * deduplicated action queue keyed by subject (PR URL, worker ID, or task ID).
 *
 * When the same PR appears in both lists, escalation data wins (taskId,
 * workspaceName, waitingMinutes) and waitingOnYou data enriches it
 * (unblockCount, missionTitle).
 *
 * TODO: replace interim (prUrl / task:id / worker:id) keys with subject-anchor
 * field once mission:subject-anchors 1-7 lands.
 */
export function buildActionQueue(
  waitingOnYou: WaitingOnYouRawItem[],
  escalationInbox: EscalationRawItem[],
): ActionQueueItem[] {
  const map = new Map<string, ActionQueueItem>();

  // Escalation items carry task links, workspace context, and merge buttons — add first
  for (const item of escalationInbox) {
    const key = item.prUrl ?? `task:${item.taskId}`;
    // BLOCKED: conflict-resolution retries exhausted — human must decide.
    // RESOLVING: conflict retry is live — agent is handling it, not the human.
    // Reviewer reached a verdict (approved or flagged) → human must merge → MERGE.
    // Agent-review still pending → REVIEW. Human-gate → MERGE.
    const chip: ActionChip = item.deadZoneExhausted
      ? 'BLOCKED'
      : item.conflictRetryTaskId
        ? 'RESOLVING'
        : (item.leaseState === 'agent_approved' || item.leaseState === 'agent_flagged')
        ? 'MERGE'
        : item.policyTier === 'agent-review' ? 'REVIEW' : 'MERGE';
    map.set(key, {
      subjectKey: key,
      chip,
      prUrl: item.prUrl ?? undefined,
      prNumber: item.prNumber ?? undefined,
      taskId: item.taskId,
      taskTitle: item.taskTitle,
      workspaceId: item.workspaceId || undefined,
      workspaceName: item.workspaceName || undefined,
      waitingMinutes: item.waitingMinutes,
      escalationReason: item.escalationReason,
      conflictRetryTaskId: item.conflictRetryTaskId ?? undefined,
      conflictRetryIteration: item.conflictRetryIteration ?? undefined,
      deadZoneExhausted: item.deadZoneExhausted ?? undefined,
      deadZoneLastRetryTaskId: item.deadZoneLastRetryTaskId ?? undefined,
    });
  }

  for (const item of waitingOnYou) {
    if (item.kind === 'merge') {
      const key = item.prUrl ?? `upstream:${item.upstreamTaskId}`;
      const existing = map.get(key);
      if (existing) {
        // Same PR is already in the map from escalation — enrich with unblock context
        map.set(key, {
          ...existing,
          upstreamTaskTitle: item.upstreamTaskTitle,
          unblockCount: (existing.unblockCount ?? 0) + (item.unblockCount ?? 0),
          missionId: existing.missionId ?? item.missionId,
          missionTitle: existing.missionTitle ?? item.missionTitle,
          prLifecycleStatus: item.prLifecycleStatus ?? existing.prLifecycleStatus,
        });
      } else {
        map.set(key, {
          subjectKey: key,
          chip: 'MERGE',
          prUrl: item.prUrl,
          prNumber: item.prNumber,
          prLifecycleStatus: item.prLifecycleStatus ?? undefined,
          upstreamTaskTitle: item.upstreamTaskTitle,
          unblockCount: item.unblockCount,
          missionId: item.missionId,
          missionTitle: item.missionTitle,
        });
      }
    } else if (item.kind === 'answer') {
      const key = `worker:${item.workerId}`;
      map.set(key, {
        subjectKey: key,
        chip: 'QUESTION',
        workerId: item.workerId,
        taskId: item.taskId,
        taskTitle: item.taskTitle,
        question: item.question,
        missionId: item.missionId,
        missionTitle: item.missionTitle,
      });
    } else if (item.kind === 'approve') {
      const key = `task:${item.taskId}`;
      if (!map.has(key)) {
        map.set(key, {
          subjectKey: key,
          chip: 'APPROVE',
          taskId: item.taskId,
          taskTitle: item.taskTitle,
          missionId: item.missionId,
          missionTitle: item.missionTitle,
        });
      }
    }
  }

  return [...map.values()].sort((a, b) => {
    const chipDiff = CHIP_ORDER.indexOf(a.chip) - CHIP_ORDER.indexOf(b.chip);
    if (chipDiff !== 0) return chipDiff;
    // Within MERGE: most impactful (unblocks more tasks) first
    if (a.chip === 'MERGE') return (b.unblockCount ?? 0) - (a.unblockCount ?? 0);
    return 0;
  });
}
