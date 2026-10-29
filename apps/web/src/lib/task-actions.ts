'use client';

/**
 * The one module behind every task action a person takes from the dashboard:
 * which actions a task's state offers, the requests they make, and the copy for
 * a refused start. `TaskActionZone` is the one renderer over it, mounted by the
 * task sheet, the full task page and the mission page's Landed drawer, so the
 * three can never offer different things for the same task.
 *
 * Every client POST to `/api/tasks/[id]/start` goes through `requestTaskStart`
 * and every POST to `/api/tasks/[id]/reassign` through `requestTaskRetry`.
 */
import type { ForceChecklistItem, WaitingKind, WaitingReason } from '@buildd/core/waiting-reason';
import { MISSION_START_COPY, type MissionStartState } from './mission-start-state';

export interface GateRefusal {
  gateReason: string;
  blockClass?: 'policy' | 'capability' | 'entitlement';
  error?: string;
  canForce?: boolean;
  backend?: string;
  /** capability_mismatch: backends the team does hold a credential for. */
  availableBackends?: string[];
  missingConnectors?: string[];
  /** connector_routing_mismatch: the connectors the role needs and cannot reach. */
  connectorFailures?: Array<{ connectorName: string }>;
  /** mission_held: whether the mission never started or was paused. */
  missionStartState?: MissionStartState;
  alternativeRole?: string;
  /** unmerged_dep_pr: the PRs holding the task. */
  blockingDeps?: Array<{ taskId: string | null; taskTitle: string | null; prUrl: string | null; prNumber: number | null }>;
  /** deferred_start: the scheduled start (ISO). */
  startAt?: string | null;
  /** entitlement_blocked: the plan limit (an EntitlementBlock, parsed by the renderer). */
  entitlement?: unknown;
  /** coordination_hold: what holds it, in order (reasons[0] is the headline). */
  waitingReasons?: WaitingReason[];
  /** coordination_hold: echo back as `force.reasonsDigest` to confirm a force. */
  reasonsDigest?: string;
  /** coordination_hold: exactly what a force skips and what stays enforced; null = not forceable. */
  force?: ForceOffer | null;
  /** coordination_hold: the gates no force lifts. */
  notForceable?: string[];
  /** 409: the reasons changed between the refusal and the confirmation. */
  reasonsChanged?: boolean;
}

/** The §7.3 confirmation a refusal carries (`coordinationHoldBody` in @buildd/core/waiting-reason). */
export interface ForceOffer {
  kinds?: WaitingKind[];
  gates: string[];
  railsRemaining: string[];
  checklist?: ForceChecklistItem[];
  risk?: string | null;
  redLines?: string[];
}

/** What `/start` accepted a Force start past (200 body `forced`). */
export interface ForcedStart {
  forceId: string;
  gates: string[];
  railsRemaining: string[];
  expiresAt: string;
}

// ── Action set ───────────────────────────────────────────────────────────────

export {
  STARTABLE_PHASES, backendDisplayName, otherBackendOf, taskActionSet, taskActionPhase,
  type Backend, type MissionExecutor, type TaskActionId, type TaskActionState,
} from './task-action-set';
import type { Backend } from './task-action-set';

/** What a person types in their own session to take a local mission's task. */
export function claimTaskCommand(taskId: string): string {
  return `claim_task {taskId: "${taskId}"}`;
}

// ── Requests ─────────────────────────────────────────────────────────────────

export interface StartRequest {
  forceOverride?: boolean;
  /**
   * Force start past a `coordination_hold` (docs/specs/force-start.md): the
   * ticked kinds and the digest of the reasons the refusal showed.
   */
  force?: { kinds: WaitingKind[]; reasonsDigest: string; note?: string; seenBlockers?: string[] };
  /** Hand the task to one runner's local UI instead of any runner. */
  targetLocalUiUrl?: string;
}

export type StartOutcome =
  | { ok: true; forced?: ForcedStart | null; waitingReasons?: WaitingReason[] }
  | { ok: false; status: number; refusal: GateRefusal | null; error: string };

/** The only client POST to `/api/tasks/[id]/start`. A 422 with a gate reason comes back as `refusal`. */
export async function requestTaskStart(taskId: string, req: StartRequest = {}): Promise<StartOutcome> {
  try {
    const res = await fetch(`/api/tasks/${taskId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(req.targetLocalUiUrl ? { targetLocalUiUrl: req.targetLocalUiUrl } : {}),
        ...(req.forceOverride ? { forceOverride: true } : {}),
        ...(req.force ? { force: req.force } : {}),
      }),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (res.ok) {
      return {
        ok: true,
        ...(body.forced ? { forced: body.forced as ForcedStart } : {}),
        ...(Array.isArray(body.waitingReasons) ? { waitingReasons: body.waitingReasons as WaitingReason[] } : {}),
      };
    }
    const error = typeof body.error === 'string' ? body.error : 'Failed to start task';
    // 409 = the coordination reasons changed under a confirmation: re-render the fresh ones.
    // A 409 `reasons_changed` is the same coordination refusal, re-rendered with
    // the fresh reasons and a note that they moved.
    const gateReason = res.status === 409 && body.gateReason === 'reasons_changed' ? 'coordination_hold' : body.gateReason;
    const refusal = (res.status === 422 || res.status === 409) && typeof gateReason === 'string'
      ? ({ ...body, gateReason, ...(res.status === 409 ? { reasonsChanged: true } : {}) } as GateRefusal)
      : null;
    return { ok: false, status: res.status, refusal, error };
  } catch (err) {
    return { ok: false, status: 0, refusal: null, error: err instanceof Error ? err.message : 'Failed to start task' };
  }
}

/**
 * The only client POST to `/api/tasks/[id]/reassign`: retry a task, on its own
 * backend or (with `backend`) on another. Omitting the backend keeps the stored one.
 */
export async function requestTaskRetry(taskId: string, opts: { backend?: Backend } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/tasks/${taskId}/reassign?force=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.backend ? { backend: opts.backend } : {}),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({})) as { error?: unknown };
    return { ok: false, error: typeof body.error === 'string' ? body.error : 'Failed to retry task' };
  } catch {
    return { ok: false, error: 'Failed to retry task' };
  }
}

/**
 * Retry now: a task buildd is already retrying, sooner. Clears the scheduled
 * start (the backoff or pause) and nothing else, so the same claim gates run.
 */
export async function requestRetryNow(taskId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startAt: null }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({})) as { error?: unknown };
    return { ok: false, error: typeof body.error === 'string' ? body.error : 'Failed to retry task' };
  } catch {
    return { ok: false, error: 'Failed to retry task' };
  }
}

/** Cancel a task that is not running (a person's own act: no reason is asked for). */
export async function requestTaskCancel(taskId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({})) as { error?: unknown };
    return { ok: false, error: typeof body.error === 'string' ? body.error : 'Failed to cancel task' };
  } catch {
    return { ok: false, error: 'Failed to cancel task' };
  }
}

/** Switch the task's backend (claude is stored as null, the default). */
export async function requestBackendSwitch(taskId: string, backend: string): Promise<boolean> {
  const res = await fetch(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backend: backend === 'claude' ? null : backend }),
  }).catch(() => null);
  return !!res?.ok;
}

export interface GateCopyContext {
  /** Number of PRs blocking the task (unmerged_dep_pr). */
  blockingCount?: number;
  /** Pre-formatted start time (deferred_start); null falls back to a placeholder. */
  deferredStartLabel?: string | null;
}

/**
 * GET the canonical waiting reasons of a pending task (the same probe `/start`
 * refuses on). Null on any error: the caller keeps its generic copy.
 */
export interface TaskWaiting {
  waitingReasons: WaitingReason[];
  /** The one reason it waits, the same explain and both queues give (lib/queue-wait-load.ts). */
  queueWait?: import('@buildd/shared').QueueWait;
  reasonsDigest?: string;
  canForce?: boolean;
  force?: ForceOffer | null;
  notForceable?: string[];
  /** An unexpired Force start awaiting its runner claim. */
  forceStart?: { kinds: string[]; expiresAt: string };
  /** Start anyway's observed phase (spec 36df686b): requested, assessing, or blocked on its prerequisite. */
  startAnyway?: { phase: 'requested' | 'assessing' | 'blocked'; label: string; executing: boolean; taskStatus: 'pending' | 'in_progress'; blockerTaskId?: string; nextStep?: string };
}

export async function fetchTaskWaiting(taskId: string): Promise<TaskWaiting | null> {
  try {
    const res = await fetch(`/api/tasks/${taskId}/waiting`);
    if (!res.ok) return null;
    const body = await res.json() as TaskWaiting & { probed?: boolean };
    return Array.isArray(body.waitingReasons) ? body : null;
  } catch {
    return null;
  }
}

/** A waiting snapshot as the refusal the start flow renders (Force start included). */
export function refusalFromWaiting(w: TaskWaiting): GateRefusal | null {
  const hard = w.waitingReasons.filter(r => r.strength === 'hard');
  if (hard.length === 0) return null;
  return {
    gateReason: 'coordination_hold',
    blockClass: 'policy',
    canForce: !!w.canForce,
    waitingReasons: hard,
    reasonsDigest: w.reasonsDigest,
    force: w.force ?? null,
    notForceable: w.notForceable,
  };
}

/** Force start is offered only for refusals a person can legitimately bypass. */
export function canOfferForce(refusal: Pick<GateRefusal, 'canForce' | 'blockClass' | 'gateReason'> | null | undefined): boolean {
  return !!refusal?.canForce && refusal.blockClass !== 'capability';
}

/** A mission_held refusal's copy; a server that predates the state meant never started. */
function missionStartCopyOf(refusal: GateRefusal) {
  return MISSION_START_COPY[refusal.missionStartState ?? 'not_started'];
}

/**
 * The label of the button that starts a refused task past its gate. A task in
 * a mission that has not started (or is paused) is simply started on its own;
 * the other gates name what they skip.
 */
export function getGateBypassLabel(refusal: GateRefusal): string {
  if (refusal.gateReason === 'mission_held') return missionStartCopyOf(refusal).taskAction;
  if (refusal.gateReason === 'deferred_start') return 'Start now anyway';
  return 'Force start';
}

export function getGateReasonTitle(refusal: GateRefusal, ctx: GateCopyContext = {}): string {
  switch (refusal.gateReason) {
    case 'deferred_start':
      return ctx.deferredStartLabel ? `Starts at ${ctx.deferredStartLabel}` : 'Scheduled start time';
    case 'unmerged_dep_pr':
      return 'Blocked: dependency PR not merged';
    case 'mission_held':
      return missionStartCopyOf(refusal).taskTitle;
    case 'mission_local':
      return 'Runs from your session';
    case 'subject_dead':
      return 'Blocked: subject PR is closed';
    case 'connector_routing_mismatch':
      return 'Blocked: required connectors not available';
    case 'mission_budget_exhausted':
      return 'Blocked: mission budget exhausted';
    case 'capability_mismatch':
      return `Blocked: no ${refusal.backend ?? 'backend'} credential available`;
    case 'entitlement_blocked':
      return 'Queued: plan limit reached';
    case 'coordination_hold':
      return refusal.reasonsChanged ? 'What it waits on changed' : 'Waiting for files';
    default:
      return 'Blocked';
  }
}

export function getGateReasonSubtitle(refusal: GateRefusal, ctx: GateCopyContext = {}): string {
  switch (refusal.gateReason) {
    case 'deferred_start':
      return 'This task has a scheduled start time. Start now to override it.';
    case 'unmerged_dep_pr': {
      const n = ctx.blockingCount ?? 1;
      return `The following ${n === 1 ? 'PR is' : 'PRs are'} blocking this task. Workers will not claim it until ${n === 1 ? 'it merges' : 'they merge'}.`;
    }
    case 'mission_held':
      return missionStartCopyOf(refusal).taskReason;
    case 'mission_local':
      return 'This mission runs from your session, so runners leave its tasks for a session to claim. "Force start" hands this task to a runner instead.';
    case 'mission_budget_exhausted':
      return 'The parent mission spent its cost budget, so workers claim none of its tasks. Raise the mission budget to release them all, or force-start this task.';
    case 'connector_routing_mismatch': {
      const missing = refusal.missingConnectors?.length ? refusal.missingConnectors : refusal.connectorFailures?.map(f => f.connectorName);
      return `This agent requires connectors that are not available in this workspace.${missing?.length ? ` Missing: ${missing.join(', ')}.` : ''} Contact your workspace admin.${refusal.alternativeRole ? ` Or re-file it with role: ${refusal.alternativeRole}.` : ''}`;
    }
    case 'capability_mismatch':
      return 'The configured backend has no server credentials. Switch to an available backend to start this task.';
    case 'entitlement_blocked':
      return 'The task starts automatically when the limit lifts.';
    case 'coordination_hold':
      return refusal.canForce
        ? (refusal.force?.kinds?.includes('dep_declared')
          ? 'It starts by itself when its prerequisite finishes. Start anyway lets its agent assess what can proceed first; the dependency stays.'
          : 'It starts by itself when this clears. Force start skips only the gate named below.')
        : 'It starts by itself when this clears. This wait cannot be forced.';
    default:
      return refusal.error || "This task can't start yet.";
  }
}

export interface RunnerFleetStatus {
  count: number;
  lastSeenSecs: number | null;
}

/**
 * Fetch runner fleet status for the workspace.
 * Returns null on any error (best-effort non-critical call).
 */
export async function fetchRunnerFleet(workspaceId: string): Promise<RunnerFleetStatus | null> {
  try {
    const res = await fetch('/api/workers/active');
    if (!res.ok) return null;
    const data = await res.json();
    const uis: Array<{ lastUpdated: string; workspaceIds: string[] }> = data.activeLocalUis || [];
    const relevant = uis.filter(u => u.workspaceIds?.includes(workspaceId));
    const now = Date.now();
    const lastSeenMs = relevant.length > 0
      ? Math.min(...relevant.map(u => now - new Date(u.lastUpdated).getTime()))
      : null;
    return {
      count: relevant.length,
      lastSeenSecs: lastSeenMs !== null ? Math.floor(lastSeenMs / 1000) : null,
    };
  } catch {
    return null;
  }
}

/**
 * The one runner fact a person needs in a task dialog: that none is online, so
 * the task starts when one connects. Counts and check-in times are operator
 * diagnostics (Settings → Runners, Health), never shown here; with a runner
 * online this says nothing.
 */
export function formatFleetStatus(fleet: RunnerFleetStatus | null, roleSlug?: string | null): string {
  if (!fleet || fleet.count > 0) return '';
  return roleSlug === 'visual-auditor'
    ? 'No runner is online. It starts when a runner with a browser connects.'
    : 'No runner is online. It starts when one connects.';
}
