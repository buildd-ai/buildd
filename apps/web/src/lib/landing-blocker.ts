/**
 * Why an unmerged PR cannot land right now, from the landing facts buildd
 * already holds, with whose move it is.
 *
 * `explain` used to read every completed task's unmerged PR as READY FOR
 * REVIEW. It did so even when the newest `pr_landing` row said
 * `mergeable_state: dirty` plus a migration collision, and when the repair
 * attempts had all ended without touching the PR. The merge rule only knew
 * "unmerged". This module names the reason the PR cannot land, so
 * `deriveMissionStateView` can say blocked, not ready.
 * docs/specs/workflow-state-kernel.md §13.11 rule 3.
 *
 * Pure, and stored facts only: explain never calls GitHub (see explain.ts).
 * Precedence, newest authority first:
 *  1. the kernel delivery (REPAIRING / BLOCKED_ON_TRUNK / ESCALATED, or a
 *     conflict on its current head);
 *  2. the newest `pr_landing` gate row, when it is about the current head (kernel)
 *     or no repair has completed since it was written (legacy);
 *  3. the legacy conflict fact (`workers.prLifecycleStatus = 'conflict'`).
 * An open repair attempt upgrades a conflict or collision to queued / running.
 */
import type { DeliveryView } from '@/lib/workflow/projections';

export type LandingBlockCause =
  | 'conflicted'
  | 'migration_collision'
  | 'repair_queued'
  | 'repair_running'
  | 'repair_exhausted'
  | 'human_decision'
  | 'trunk_blocked'
  | 'ci_pending';

export interface LandingBlocker {
  taskId: string;
  prNumber: number | null;
  prUrl: string | null;
  cause: LandingBlockCause;
  /** Whose move it is: buildd's machinery, or a person. */
  owner: 'platform' | 'person';
  /** Plain-language state, e.g. "PR #12 conflicts with its base". */
  label: string;
  /** What happens next, or what the person should do. */
  nextAction: string;
  derivedFrom: 'workflow_deliveries' | 'gate_events.pr_landing' | 'workers.prLifecycleStatus';
}

export interface LandingGateRow {
  occurredAt: string;
  outcome: string;
  reason: string | null;
  headSha: string | null;
}

export interface RepairAttemptRef {
  status: string;
  /** A worker has it (left pending, or a live worker is on it). */
  claimed: boolean;
  completedAt?: string | null;
}

/** Landing-door outcomes that refused the merge. `warned` is shadow mode: hypothetical, not a fact. */
const REFUSED = new Set(['deferred', 'stranded', 'rejected']);

const OPEN = new Set(['pending', 'assigned', 'in_progress', 'running', 'waiting_input', 'blocked']);

const COLLISION_RE = /migration (number )?collision|migration .* collides/i;

function classifyLandingReason(reason: string): LandingBlockCause | null {
  // A dirty PR is a conflict first: merging the base in is the step either way.
  if (/mergeable_state: dirty|has conflicts|merge conflict/i.test(reason)) return 'conflicted';
  if (COLLISION_RE.test(reason)) return 'migration_collision';
  if (/escalated .* to a person|needs a person|landing_needs_human/i.test(reason)) return 'human_decision';
  if (/CI checks still pending|checks? (are )?(still )?(pending|running|in_progress)/i.test(reason)) return 'ci_pending';
  return null;
}

export function deriveLandingBlocker(p: {
  taskId: string;
  prNumber: number | null;
  prUrl: string | null;
  delivery?: Pick<DeliveryView, 'state' | 'headSha' | 'prState' | 'headline' | 'detail' | 'currentAttempt' | 'owner'> | null;
  /** Newest `pr_landing` row for the task whose outcome refused the landing. */
  landing?: LandingGateRow | null;
  prLifecycleStatus?: string | null;
  /** Conflict / migration repair attempts on this PR, newest first. */
  repairs?: RepairAttemptRef[];
}): LandingBlocker | null {
  const pr = p.prNumber != null ? `PR #${p.prNumber}` : 'The PR';
  const base = { taskId: p.taskId, prNumber: p.prNumber, prUrl: p.prUrl };
  const repairs = p.repairs ?? [];
  const openRepair = repairs.find(r => OPEN.has(r.status)) ?? null;

  const d = p.delivery;
  if (d) {
    if (d.state === 'ESCALATED') {
      return { ...base, cause: 'human_decision', owner: 'person', label: `${pr}: ${d.headline}`, nextAction: d.detail ?? 'Decide how this PR lands; no automated step will clear it.', derivedFrom: 'workflow_deliveries' };
    }
    if (d.state === 'BLOCKED_ON_TRUNK') {
      return { ...base, cause: 'trunk_blocked', owner: 'platform', label: `${pr} is waiting on a red trunk`, nextAction: 'Nothing to do on this PR: it lands once trunk is green again.', derivedFrom: 'workflow_deliveries' };
    }
    if (d.state === 'REPAIRING') {
      const running = d.currentAttempt ? d.currentAttempt.status !== 'pending' : !!openRepair?.claimed;
      return {
        ...base,
        cause: running ? 'repair_running' : 'repair_queued',
        owner: 'platform',
        label: `${pr}: ${running ? 'a repair is running' : 'a repair is queued, no worker yet'}`,
        nextAction: 'Nothing to do yet: buildd is repairing the branch and re-checks it when the repair pushes.',
        derivedFrom: 'workflow_deliveries',
      };
    }
  }

  let cause: LandingBlockCause | null = null;
  let derivedFrom: LandingBlocker['derivedFrom'] = 'gate_events.pr_landing';
  let detail: string | null = null;
  const row = p.landing;
  if (row?.reason && REFUSED.has(row.outcome)) {
    const lastRepairDone = repairs.find(r => r.status === 'completed' && r.completedAt)?.completedAt ?? null;
    const current = d
      ? !!row.headSha && row.headSha === d.headSha
      : !lastRepairDone || Date.parse(lastRepairDone) <= Date.parse(row.occurredAt);
    if (current) {
      cause = classifyLandingReason(row.reason);
      detail = row.reason;
    }
  }
  if (!cause && (d ? d.prState === 'conflict' : p.prLifecycleStatus === 'conflict')) {
    cause = 'conflicted';
    derivedFrom = d ? 'workflow_deliveries' : 'workers.prLifecycleStatus';
  }
  if (!cause) return null;

  if ((cause === 'conflicted' || cause === 'migration_collision') && openRepair) {
    return {
      ...base,
      cause: openRepair.claimed ? 'repair_running' : 'repair_queued',
      owner: 'platform',
      label: `${pr} ${cause === 'conflicted' ? 'conflicts with its base' : 'has a migration collision'}; ${openRepair.claimed ? 'a repair is running' : 'a repair is queued, no worker yet'}`,
      nextAction: 'Nothing to do yet: buildd is repairing the branch.',
      derivedFrom,
    };
  }

  const ended = repairs.length > 0 && !openRepair;
  switch (cause) {
    case 'conflicted':
    case 'migration_collision': {
      const alsoCollides = cause === 'conflicted' && !!detail && COLLISION_RE.test(detail);
      const what = cause === 'conflicted'
        ? `conflicts with its base${alsoCollides ? ' and has a migration number collision' : ''}`
        : 'has a migration number collision';
      return ended
        ? {
            ...base, cause: 'repair_exhausted', owner: 'person',
            label: `${pr} ${what}, and its ${repairs.length} repair attempt${repairs.length === 1 ? '' : 's'} ended without fixing it`,
            nextAction: cause === 'conflicted'
              ? `Merge the PR's base into its head branch and resolve the conflicts${alsoCollides ? ', regenerate the migration at the next free index' : ''}, or close the PR.`
              : 'Merge the base in and regenerate the migration at the next free index, or close the PR.',
            derivedFrom,
          }
        : {
            ...base, cause, owner: 'platform',
            label: `${pr} ${what}`,
            nextAction: 'Not ready to merge: buildd files a repair for it. If none appears, re-run the landing check.',
            derivedFrom,
          };
    }
    case 'human_decision':
      return { ...base, cause, owner: 'person', label: `${pr} needs a person to decide how it lands`, nextAction: detail ?? 'Decide how this PR lands.', derivedFrom };
    case 'ci_pending':
      return { ...base, cause, owner: 'platform', label: `${pr}: CI is still running`, nextAction: 'Nothing to do yet: it is re-checked when CI finishes.', derivedFrom };
    default:
      return null;
  }
}
