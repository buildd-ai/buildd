import type { CiGate } from './ci-gate';

export type ActionChip =
  | 'MERGE' | 'BLOCKED' | 'RECONNECT' | 'REVIEW' | 'QUESTION' | 'APPROVE'
  | 'RESOLVING' | 'FIXING_CI' | 'CI_RUNNING';

/**
 * Chips an agent is already handling. They stay visible (a stuck fix must not
 * become invisible) but never count toward "waiting on you" and never sort
 * above work that genuinely needs a human.
 */
const AGENT_HANDLED_CHIPS: ReadonlySet<ActionChip> = new Set<ActionChip>([
  'RESOLVING', 'FIXING_CI', 'CI_RUNNING',
]);

export function isActionableChip(chip: ActionChip): boolean {
  return !AGENT_HANDLED_CHIPS.has(chip);
}

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
  kind: 'merge' | 'approve' | 'answer' | 'reconnect';
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
  /** kind === 'reconnect' — the connector whose credential needs re-authorising. */
  connectorId?: string;
  connectorName?: string;
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
  escalationReason: string | null;
  /** Mission the PR's task belongs to — drives the card's arc context line. */
  missionId?: string | null;
  missionTitle?: string | null;
  waitingMinutes: number | null;
  /** CI state of the PR — resolved by lib/ci-gate before the queue is built. */
  ciGate?: CiGate | null;
  /** Reviewer's recommended next step, when it escalated to a human. */
  recommendation?: string | null;
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
  /**
   * Mission of the tasks this PR unblocks — distinct from missionTitle, which is
   * the mission the PR itself belongs to. Only set for blocker-derived items.
   */
  unblockMissionTitle?: string | null;
  waitingMinutes?: number | null;
  escalationReason?: string | null;
  workerId?: string;
  question?: string;
  /** Set when the card is CI-gated — drives FIXING_CI / CI_RUNNING / CI BLOCKED copy. */
  ciGate?: CiGate | null;
  /**
   * The last agent's own advice on what a human should do next
   * (tasks.result.nextSuggestion). Shown on BLOCKED cards, where the human is
   * being asked to decide something an agent already failed at.
   */
  recommendation?: string | null;
  /** Set when chip === 'RESOLVING' — the task actively resolving merge conflicts. */
  conflictRetryTaskId?: string | null;
  conflictRetryIteration?: number | null;
  /** Set when chip === 'BLOCKED' — retries exhausted, human decision required. */
  deadZoneExhausted?: boolean;
  /** Link target for the BLOCKED card's primary CTA. */
  deadZoneLastRetryTaskId?: string | null;
  /** Set when chip === 'RECONNECT' — the connector needing re-auth. */
  connectorId?: string;
  connectorName?: string;
}

// Chip display order: lower index = shown first.
// BLOCKED: retries exhausted, human must decide — actionable, placed after MERGE.
// RESOLVING is last — it is informational (agent is handling it), not action-required.
// RECONNECT sits high: a connector that can no longer re-authorise itself
// silently starves every task that needs it, and the fix is a single tap.
const CHIP_ORDER: ActionChip[] = [
  'MERGE', 'BLOCKED', 'RECONNECT', 'REVIEW', 'QUESTION', 'APPROVE',
  'RESOLVING', 'FIXING_CI', 'CI_RUNNING',
];

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
    // Otherwise: human-gate = MERGE, agent-review = REVIEW.
    // Precedence: a conflict outranks CI (an unmergeable branch is why CI
    // cannot pass), and any CI gate outranks the merge policy — a red PR is not
    // waiting on the human until no agent is left working on it.
    const ciGate = item.ciGate ?? null;
    const chip: ActionChip = item.deadZoneExhausted
      ? 'BLOCKED'
      : item.conflictRetryTaskId
        ? 'RESOLVING'
        : ciGate?.kind === 'fixing'
          ? 'FIXING_CI'
          : ciGate?.kind === 'running'
            ? 'CI_RUNNING'
            : ciGate?.kind === 'blocked'
              ? 'BLOCKED'
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
      missionId: item.missionId ?? undefined,
      missionTitle: item.missionTitle ?? undefined,
      waitingMinutes: item.waitingMinutes,
      ciGate,
      // A CI block states its own reason; the merge-policy reason ("manual merge
      // required") would be misleading while the PR cannot merge at all.
      escalationReason: ciGate?.kind === 'blocked' ? ciGate.reason : item.escalationReason,
      recommendation: ciGate?.kind === 'blocked'
        ? ciGate.recommendation
        : item.recommendation ?? null,
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
          unblockMissionTitle: item.missionTitle,
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
          unblockMissionTitle: item.missionTitle,
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
    } else if (item.kind === 'reconnect') {
      const key = `connector:${item.connectorId}`;
      if (!map.has(key)) {
        map.set(key, {
          subjectKey: key,
          chip: 'RECONNECT',
          connectorId: item.connectorId,
          connectorName: item.connectorName,
        });
      }
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
    // Within MERGE: most impactful (unblocks more tasks) first, then arc-linked
    // ahead of orphans, then freshest — so a 90-day PR nobody is waiting on
    // never outranks the merge that unblocks a live mission.
    if (a.chip === 'MERGE') {
      const impactDiff = (b.unblockCount ?? 0) - (a.unblockCount ?? 0);
      if (impactDiff !== 0) return impactDiff;
      const arcDiff = Number(!!b.missionId) - Number(!!a.missionId);
      if (arcDiff !== 0) return arcDiff;
      return (a.waitingMinutes ?? 0) - (b.waitingMinutes ?? 0);
    }
    return 0;
  });
}
