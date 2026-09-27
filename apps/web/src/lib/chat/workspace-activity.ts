/**
 * Which in-reach workspaces a spanning read looks at. "Active" comes from
 * data (the workspace's latest task activity), not from the routing decision
 * call: a question like "what shipped this week?" names no workspace, and the
 * decision model is weak at dates, so the recency cut is a plain comparison.
 */

/** A workspace with no task activity for this long is skipped by spanning reads. */
export const ACTIVE_WINDOW_DAYS = 14;

export interface WorkspaceActivity { id: string; name: string; lastActiveAt?: string | null }

/**
 * Split into the workspaces a spanning read checks and the ones it skips.
 * Nothing active (or no activity known) ⇒ check them all rather than none.
 */
export function splitByActivity<W extends WorkspaceActivity>(list: readonly W[], now: number): { active: W[]; idle: W[] } {
  const cutoff = now - ACTIVE_WINDOW_DAYS * 86_400_000;
  const active = list.filter(w => w.lastActiveAt !== undefined && w.lastActiveAt !== null && Date.parse(w.lastActiveAt) >= cutoff);
  if (active.length === 0 || list.every(w => w.lastActiveAt === undefined)) return { active: [...list], idle: [] };
  return { active, idle: list.filter(w => !active.includes(w)) };
}

/** "active today" / "active 3d ago" / "idle 40d" / "no activity", for the context block. */
export function activityLabel(lastActiveAt: string | null | undefined, now: number): string | null {
  if (lastActiveAt === undefined) return null;
  if (lastActiveAt === null) return 'no activity';
  const days = Math.max(0, Math.floor((now - Date.parse(lastActiveAt)) / 86_400_000));
  if (days > ACTIVE_WINDOW_DAYS) return `idle ${days}d`;
  return days === 0 ? 'active today' : `active ${days}d ago`;
}
