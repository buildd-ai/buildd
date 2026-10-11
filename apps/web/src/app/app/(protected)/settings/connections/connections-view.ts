/**
 * Pure helpers for Settings → Connected apps (ConnectionsSection.tsx): the
 * words each row shows and the change a picker selection turns into.
 */
import type { ConnectionSummary } from '@/lib/mcp-grant-patch';

export const KIND_LABEL = { person: 'Acts as you', agent: 'Agent working for you' } as const;
export const ACCESS_LABEL = { read: 'Read only', 'read-write': 'Read and write' } as const;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 hours ago", "yesterday", "12 days ago". Coarse on purpose: tokens refresh hourly. */
export function lastActive(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'not used since it was connected';
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60 * 60 * 1000) return 'active in the last hour';
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 24) return `active ${plural(hours, 'hour')} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'active yesterday';
  return `active ${plural(days, 'day')} ago`;
}

/** The one meta line under a connection's name. */
export function connectionMeta(c: Pick<ConnectionSummary, 'workspaces' | 'access' | 'lastActiveAt'>, now?: Date): string {
  return [plural(c.workspaces.length, 'workspace'), ACCESS_LABEL[c.access].toLowerCase(), lastActive(c.lastActiveAt, now)].join(' · ');
}

/** What a picker selection changes on a connection, relative to what it reaches now. */
export function selectionChange(current: readonly string[], selected: readonly string[]): { add: string[]; remove: string[] } {
  const had = new Set(current);
  const want = new Set(selected);
  return {
    add: [...want].filter((id) => !had.has(id)),
    remove: [...had].filter((id) => !want.has(id)),
  };
}

/** Workspaces grouped under their team, in the order the API sorted them. */
export function byTeam(workspaces: ConnectionSummary['workspaces']): Array<{ teamId: string; teamName: string; workspaces: ConnectionSummary['workspaces'] }> {
  const groups: Array<{ teamId: string; teamName: string; workspaces: ConnectionSummary['workspaces'] }> = [];
  for (const w of workspaces) {
    let g = groups.find((x) => x.teamId === w.teamId);
    if (!g) groups.push(g = { teamId: w.teamId, teamName: w.teamName, workspaces: [] });
    g.workspaces.push(w);
  }
  return groups;
}
