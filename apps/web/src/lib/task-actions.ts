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
import { deriveTaskPhase, type TaskPhase } from './task-presentation';

export interface GateRefusal {
  gateReason: string;
  blockClass?: 'policy' | 'capability' | 'entitlement';
  error?: string;
  canForce?: boolean;
  /** workspace_cap_reached: the person may start this one task past the cap. */
  canExempt?: boolean;
  backend?: string;
  /** capability_mismatch: backends the team does hold a credential for. */
  availableBackends?: string[];
  active?: number;
  cap?: number;
  queuePosition?: number;
  missingConnectors?: string[];
  alternativeRole?: string;
  /** unmerged_dep_pr: the PRs holding the task. */
  blockingDeps?: Array<{ taskId: string | null; taskTitle: string | null; prUrl: string | null; prNumber: number | null }>;
  /** deferred_start: the scheduled start (ISO). */
  startAt?: string | null;
  /** entitlement_blocked: the plan limit (an EntitlementBlock, parsed by the renderer). */
  entitlement?: unknown;
}

// ── Action set ───────────────────────────────────────────────────────────────

export type Backend = 'claude' | 'codex';
export type MissionExecutor = 'runner' | 'local';

/** Phases where nothing is running and a person can ask for a start. */
export const STARTABLE_PHASES: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
  'pending', 'budget_paused', 'mission_budget_exhausted', 'subject_dead',
]);

/**
 * What a task's state offers, in render order. The renderer draws exactly
 * these, and the parity test compares them across surfaces:
 * - `answer`: reply to the agent's open question;
 * - `retry` / `switch_backend` / `history`: a failed task;
 * - `blocked`: the dependency notice (no action, by design);
 * - `claim_hint`: `claim_task {taskId}` for a task only a local session claims;
 * - `run_now`: ask for a start now (a gate refusal becomes Force start inline).
 */
export type TaskActionId = 'answer' | 'retry' | 'switch_backend' | 'history' | 'blocked' | 'claim_hint' | 'run_now';

export interface TaskActionState {
  phase: TaskPhase;
  isBlocked: boolean;
  backend: Backend | null;
  /** The live worker has a question waiting. */
  hasQuestion: boolean;
  /** The host can link to the full history (the sheet and drawer, not the page itself). */
  hasHistory: boolean;
  /** The task's mission executor; `local` means runners never claim it. */
  missionExecutor?: MissionExecutor | null;
  /**
   * Whether the other backend has a credential for this workspace. `false`
   * drops the switch (offering Codex to a team that never set it up only
   * produces a second failure); omitted means unknown and keeps it.
   */
  otherBackendAvailable?: boolean;
}

/** A backend as a product name: "Claude", "Codex". */
export function backendDisplayName(backend: Backend | string): string {
  if (backend === 'codex') return 'Codex';
  if (backend === 'claude') return 'Claude';
  return backend.charAt(0).toUpperCase() + backend.slice(1);
}

export function otherBackendOf(backend: Backend | null): Backend | null {
  return backend === 'codex' ? 'claude' : backend === 'claude' ? 'codex' : null;
}

export function taskActionSet(s: TaskActionState): TaskActionId[] {
  const out: TaskActionId[] = [];
  const waiting = s.phase === 'waiting_input';
  if (waiting && s.hasQuestion) out.push('answer');
  if (s.phase === 'failed' && !waiting) {
    out.push('retry');
    if (otherBackendOf(s.backend) && s.otherBackendAvailable !== false) out.push('switch_backend');
    if (s.hasHistory) out.push('history');
  }
  if (s.isBlocked) out.push('blocked');
  if (STARTABLE_PHASES.has(s.phase) && !s.isBlocked) {
    if (s.missionExecutor === 'local') out.push('claim_hint');
    out.push('run_now');
  }
  return out;
}

/**
 * Phase and blocked flag for a task the host holds as a light row (the sheet's
 * summary, the board model). The full task page has more inputs and calls
 * `deriveTaskPhase` itself; both end in the same function.
 */
export function taskActionPhase(i: {
  taskStatus: string;
  taskMode?: string | null;
  workerStatus?: string | null;
  workerWaitingFor?: unknown;
  blockedByCount: number;
}): { phase: TaskPhase; isBlocked: boolean } {
  const isBlocked = i.taskStatus === 'pending' && i.blockedByCount > 0;
  const phase = deriveTaskPhase({
    taskStatus: i.taskStatus,
    taskMode: i.taskMode ?? null,
    workerStatus: i.workerStatus ?? null,
    workerWaitingFor: i.workerWaitingFor,
    isBlocked,
  });
  return { phase, isBlocked };
}

/** What a person types in their own session to take a local mission's task. */
export function claimTaskCommand(taskId: string): string {
  return `claim_task {taskId: "${taskId}"}`;
}

// ── Requests ─────────────────────────────────────────────────────────────────

export interface StartRequest {
  forceOverride?: boolean;
  capExempt?: boolean;
  /** Hand the task to one runner's local UI instead of any runner. */
  targetLocalUiUrl?: string;
}

export type StartOutcome =
  | { ok: true }
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
        ...(req.capExempt ? { capExempt: true } : {}),
      }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const error = typeof body.error === 'string' ? body.error : 'Failed to start task';
    const refusal = res.status === 422 && typeof body.gateReason === 'string'
      ? ({ ...body, gateReason: body.gateReason } as GateRefusal)
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

/** Force start is offered only for refusals a person can legitimately bypass. */
export function canOfferForce(refusal: Pick<GateRefusal, 'canForce' | 'blockClass' | 'gateReason'> | null | undefined): boolean {
  return !!refusal?.canForce && refusal.blockClass !== 'capability' && refusal.gateReason !== 'workspace_cap_reached';
}

export function getGateReasonTitle(refusal: GateRefusal, ctx: GateCopyContext = {}): string {
  switch (refusal.gateReason) {
    case 'deferred_start':
      return ctx.deferredStartLabel ? `Starts at ${ctx.deferredStartLabel}` : 'Scheduled start time';
    case 'unmerged_dep_pr':
      return 'Blocked: dependency PR not merged';
    case 'mission_held':
      return 'Blocked: parent mission is held';
    case 'mission_local':
      return 'Running in a local session';
    case 'subject_dead':
      return 'Blocked: subject PR is closed';
    case 'connector_routing_mismatch':
      return 'Blocked: required connectors not available';
    case 'mission_budget_exhausted':
      return 'Blocked: mission budget exhausted';
    case 'capability_mismatch':
      return `Blocked: no ${refusal.backend ?? 'backend'} credential available`;
    case 'workspace_cap_reached':
      return `Workspace full (${refusal.active}/${refusal.cap} running)`;
    case 'entitlement_blocked':
      return 'Queued: plan limit reached';
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
      return 'The parent mission is held. Workers claim none of its tasks until you arm the mission. "Force start" bypasses the hold for this task only.';
    case 'mission_local':
      return 'This mission runs in a local session, so runners leave its tasks for that session to claim. "Force start" hands this task to a runner instead.';
    case 'mission_budget_exhausted':
      return 'The parent mission spent its cost budget, so workers claim none of its tasks. Raise the mission budget to release them all, or force-start this task.';
    case 'connector_routing_mismatch':
      return `The role requires connectors that are not available in this workspace.${refusal.missingConnectors?.length ? ` Missing: ${refusal.missingConnectors.join(', ')}.` : ''} Contact your workspace admin.${refusal.alternativeRole ? ` Or re-file it with role: ${refusal.alternativeRole}.` : ''}`;
    case 'capability_mismatch':
      return 'The configured backend has no server credentials. Switch to an available backend to start this task.';
    case 'entitlement_blocked':
      return 'The task starts automatically when the limit lifts.';
    case 'workspace_cap_reached':
      return `Queued. The task starts when a slot opens.${typeof refusal.queuePosition === 'number' && refusal.queuePosition > 0 ? ` ${refusal.queuePosition} other pending task${refusal.queuePosition === 1 ? '' : 's'} ahead of it.` : ''}`;
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
 * Format runner fleet status for display in a gate refusal.
 */
export function formatFleetStatus(fleet: RunnerFleetStatus | null, roleSlug?: string | null): string {
  if (!fleet) return '';
  if (fleet.count === 0) {
    let msg = 'No runners online. The task starts when a runner connects.';
    if (roleSlug === 'visual-auditor') {
      msg += ' This role requires a browser-capable runner.';
    }
    return msg;
  }
  let msg = `${fleet.count} runner${fleet.count !== 1 ? 's' : ''} online`;
  if (fleet.lastSeenSecs !== null) {
    const ago = fleet.lastSeenSecs < 60
      ? `${fleet.lastSeenSecs}s ago`
      : `${Math.floor(fleet.lastSeenSecs / 60)}m ago`;
    msg += `, last seen ${ago}`;
  }
  msg += '. If the runner is mid-task, it claims this task on its next poll.';
  if (roleSlug === 'visual-auditor') {
    msg += ' This role requires a browser-capable runner.';
  }
  return msg;
}
