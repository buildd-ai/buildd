'use client';

/**
 * Shared gate-reason copy and force-flow helpers for task start actions.
 * Used by both TaskActionZone (missions sheet) and StartTaskButton (full page).
 */

export interface GateRefusal {
  gateReason: string;
  blockClass?: 'policy' | 'capability';
  error?: string;
  canForce?: boolean;
  backend?: string;
  active?: number;
  cap?: number;
  queuePosition?: number;
  missingConnectors?: string[];
  alternativeRole?: string;
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
