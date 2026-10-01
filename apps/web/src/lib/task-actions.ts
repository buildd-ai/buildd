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
}

export function getGateReasonTitle(gateReason: string): string {
  switch (gateReason) {
    case 'mission_local':
      return 'Running in a local session';
    case 'mission_held':
      return 'Mission is held';
    case 'mission_budget_exhausted':
      return 'Mission budget exhausted';
    case 'unmerged_dep_pr':
      return 'Dependency PR not merged';
    case 'deferred_start':
      return 'Scheduled start time';
    case 'subject_dead':
      return 'Subject PR is closed';
    case 'connector_routing_mismatch':
      return 'Required connectors not available';
    case 'capability_mismatch':
      return 'Backend credential unavailable';
    case 'workspace_cap_reached':
      return 'Workspace full';
    default:
      return 'Blocked';
  }
}

export function getGateReasonSubtitle(gateReason: string, error?: string): string {
  switch (gateReason) {
    case 'mission_local':
      return 'This mission runs in a local session. Force start to hand it to a runner.';
    case 'mission_held':
      return 'Arm the mission or force start this task to bypass the hold.';
    case 'mission_budget_exhausted':
      return 'Raise the mission budget or force start this task to run it anyway.';
    case 'unmerged_dep_pr':
      return 'Merge the blocking PRs or force start to bypass this gate.';
    case 'deferred_start':
      return 'This task has a scheduled start time. Start now to override it.';
    case 'subject_dead':
      return 'The subject PR is closed, blocking this task.';
    case 'connector_routing_mismatch':
      return 'The role requires connectors not available in this workspace. Contact your workspace admin or re-file with a different role.';
    case 'capability_mismatch':
      return 'The configured backend has no server credentials. Switch to an available backend to start this task.';
    case 'workspace_cap_reached':
      return 'The workspace is at its concurrent task limit. The task starts when a slot opens.';
    default:
      return error || 'This task cannot start yet.';
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
