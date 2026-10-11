/**
 * Settings → Workspaces list shape and its pure ordering rules. Type-only
 * imports, so the client list can group rows without pulling server code into
 * its bundle.
 */
import type { RunnerSize, WorkspaceExecutor } from '@buildd/shared';

/** A setting on this workspace that is not the default, as a chip linking to its editor. */
export interface WorkspaceDiffer {
  key: 'gitWorkflow' | 'mergePolicy' | 'ciRetry';
  label: string;
  href: string;
}

/** One workspace as the list renders it (built by rows.ts buildWorkspaceRows). */
export interface WorkspaceRow {
  id: string;
  name: string;
  teamId: string;
  /** Null when the team can't be resolved; the list then shows no heading for it. */
  teamName: string | null;
  /** Only the settings that differ from WORKSPACE_DEFAULTS. */
  differs: WorkspaceDiffer[];
  /** Where its tasks run; `size` only for cloud. */
  runsOn: { executor: WorkspaceExecutor; size: RunnerSize | null };
  /** When its newest task was created (ISO), or null when it has none. */
  lastActivityAt: string | null;
  openTasks: number;
  health: { stuckTasks: number; redPrs: number };
  /** Owner/admin of the workspace's team: gitConfig writes are admin-only. */
  canEdit: boolean;
  /** Admin here and on at least one other team (the precheck requires both). */
  canMove: boolean;
}

/** No task created for this long puts a workspace under "Inactive". */
export const INACTIVE_AFTER_DAYS = 30;

const ts = (r: WorkspaceRow) => (r.lastActivityAt ? Date.parse(r.lastActivityAt) : -Infinity);

/** Most recent activity first; never-active last; ties by name. */
export function sortByActivity(rows: WorkspaceRow[]): WorkspaceRow[] {
  return [...rows].sort((a, b) => ts(b) - ts(a) || a.name.localeCompare(b.name));
}

/** No task in INACTIVE_AFTER_DAYS, or none ever. */
export function isInactive(row: WorkspaceRow, now: Date): boolean {
  if (!row.lastActivityAt) return true;
  return now.getTime() - Date.parse(row.lastActivityAt) > INACTIVE_AFTER_DAYS * 86_400_000;
}

export interface WorkspaceGroup {
  teamId: string;
  teamName: string | null;
  active: WorkspaceRow[];
  inactive: WorkspaceRow[];
}

/**
 * Rows grouped by team (headings only when they span more than one team),
 * teams ordered by their newest activity, each split into active and inactive.
 * A team whose name can't be resolved never gets a made-up heading: its group
 * goes last, so its rows never read as part of a named team above them.
 */
export function groupWorkspaceRows(rows: WorkspaceRow[], now: Date): { showTeamHeadings: boolean; groups: WorkspaceGroup[] } {
  const byTeam = new Map<string, WorkspaceGroup>();
  for (const r of sortByActivity(rows)) {
    let g = byTeam.get(r.teamId);
    if (!g) {
      g = { teamId: r.teamId, teamName: r.teamName, active: [], inactive: [] };
      byTeam.set(r.teamId, g);
    }
    (isInactive(r, now) ? g.inactive : g.active).push(r);
  }
  // Insertion order follows sortByActivity, so teams already come newest first.
  const groups = [...byTeam.values()].sort((a, b) => Number(a.teamName === null) - Number(b.teamName === null));
  return { showTeamHeadings: groups.length > 1, groups };
}
