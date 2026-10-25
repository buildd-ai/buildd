/**
 * Pure helpers for Settings → Connected apps (ConnectionsSection.tsx): the
 * words each row shows, the change a picker selection turns into, and the
 * review of a team access edit before it is saved.
 */
import type { ConnectionSummary, ConnectionTeam, TeamModeChange } from '@/lib/mcp-grant-patch';
import type { ConsentTeam } from '@/lib/oauth/account-consent';

export const KIND_LABEL = { person: 'Acts as you', agent: 'Agent working for you' } as const;
export const ACCESS_LABEL = { read: 'Read only', 'read-write': 'Read and write' } as const;

/** A team's access in the editor: one of the two modes, or none. */
export type TeamChoice = 'none' | 'all' | 'specific';
export const MODE_LABEL: Record<TeamChoice, string> = {
  none: 'No access',
  all: 'All current and future workspaces',
  specific: 'Specific workspaces',
};

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

/**
 * How much a connection reaches, worded so a count never reads as a fixed
 * set when a team on all workspaces makes it grow.
 */
export function reachSummary(c: Pick<ConnectionSummary, 'workspaces' | 'teams'>): string {
  const growing = (c.teams ?? []).filter((t) => t.mode === 'all').length;
  const now = plural(c.workspaces.length, 'workspace');
  if (growing === 0) return now;
  return `${now} now, plus new ones in ${plural(growing, 'team')}`;
}

/** The one meta line under a connection's name. */
export function connectionMeta(c: Pick<ConnectionSummary, 'workspaces' | 'teams' | 'access' | 'lastActiveAt'>, now?: Date): string {
  return [reachSummary(c), ACCESS_LABEL[c.access].toLowerCase(), lastActive(c.lastActiveAt, now)].join(' · ');
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

/** A team's current access on a connection. */
export function teamAccess(c: Pick<ConnectionSummary, 'teams'>, teamId: string): ConnectionTeam | null {
  return (c.teams ?? []).find((t) => t.teamId === teamId) ?? null;
}

/**
 * The selection the editor starts from: what the connection reaches in the
 * team now. Switching a team from all to specific therefore starts from the
 * currently accessible set, and saving without changes freezes exactly it.
 */
export function initialTeamSelection(c: Pick<ConnectionSummary, 'teams'>, teamId: string): string[] {
  return teamAccess(c, teamId)?.workspaces.map((w) => w.id) ?? [];
}

/** Workspaces the editor offers for a team: ordinary ones, plus an internal one the connection already has. */
export function editableWorkspaces(team: ConsentTeam, keep: readonly string[]): ConsentTeam {
  const kept = new Set(keep);
  return { ...team, workspaces: team.workspaces.filter((w) => !w.system || kept.has(w.id)) };
}

export interface TeamEditReview {
  /** The PATCH team change, or null when nothing would change. */
  change: TeamModeChange | null;
  /** True when the change lets the app reach more than it does now. */
  expands: boolean;
  /** Plain sentences, shown before Save. */
  lines: string[];
  /** Why Save is not possible, if it is not. */
  invalid?: string;
}

/**
 * What saving a team edit would do, in words, before anything is sent. Any
 * widening (a new team, all workspaces, an added workspace) is spelled out
 * with the permission and identity it inherits.
 */
export function reviewTeamEdit(args: {
  connection: Pick<ConnectionSummary, 'teams' | 'access' | 'actsAs' | 'clientName' | 'workspaces'>;
  team: ConsentTeam;
  choice: TeamChoice;
  selected: readonly string[];
}): TeamEditReview {
  const { connection: c, team, choice } = args;
  const current = teamAccess(c, team.id);
  const currentIds = new Set(current?.workspaces.map((w) => w.id) ?? []);
  const was: TeamChoice = current ? current.mode : 'none';
  const how = `${ACCESS_LABEL[c.access].toLowerCase()}, ${c.actsAs === 'person' ? 'acting as you' : 'as your agent'}`;
  const ordinary = team.workspaces.filter((w) => !w.system).length;

  if (choice === 'none') {
    if (was === 'none') return { change: null, expands: false, lines: [] };
    const elsewhere = c.workspaces.filter((w) => w.teamId !== team.id).length;
    if (elsewhere === 0) {
      return { change: null, expands: false, lines: [], invalid: `${c.clientName} would reach nothing. Revoke it instead.` };
    }
    return {
      change: { teamId: team.id, mode: 'none' },
      expands: false,
      lines: [`${c.clientName} loses access to ${team.name}: ${plural(currentIds.size, 'workspace')} now, and any added later.`],
    };
  }

  if (choice === 'all') {
    if (was === 'all') return { change: null, expands: false, lines: [] };
    const gained = team.workspaces.filter((w) => !w.system && !currentIds.has(w.id)).length;
    const lines = [
      `${c.clientName} gets every workspace in ${team.name}: ${plural(ordinary, 'workspace')} now${gained > 0 ? `, ${gained} more than today` : ''}, and any created in or moved into ${team.name} later.`,
      `They get the same access: ${how}.`,
    ];
    return { change: { teamId: team.id, mode: 'all' }, expands: true, lines };
  }

  const selected = [...new Set(args.selected)].filter((id) => team.workspaces.some((w) => w.id === id));
  if (selected.length === 0) {
    return { change: null, expands: false, lines: [], invalid: `Tick at least one workspace in ${team.name}, or choose No access.` };
  }
  const added = selected.filter((id) => !currentIds.has(id)).length;
  const removed = [...currentIds].filter((id) => !selected.includes(id)).length;
  if (was === 'specific' && added === 0 && removed === 0) return { change: null, expands: false, lines: [] };
  const lines: string[] = [];
  if (was === 'all') {
    lines.push(`${c.clientName} keeps exactly the ${plural(selected.length, 'workspace')} ticked in ${team.name}. Workspaces created in or moved into ${team.name} later are not included.`);
  } else if (was === 'none') {
    lines.push(`${c.clientName} gets ${plural(selected.length, 'workspace')} in ${team.name}, ${how}.`);
  } else {
    if (added > 0) lines.push(`Adds ${plural(added, 'workspace')} in ${team.name}, ${how}.`);
    if (removed > 0) lines.push(`Removes ${plural(removed, 'workspace')} in ${team.name}.`);
  }
  if (was === 'all' && removed > 0) lines.push(`${plural(removed, 'workspace')} it reaches today ${removed === 1 ? 'is' : 'are'} no longer included.`);
  return {
    change: { teamId: team.id, mode: 'specific', workspaceIds: selected },
    expands: was === 'none' || added > 0,
    lines,
  };
}

/** The confirmation after a save: when it applies, without the app reconnecting. */
export function savedMessage(clientName: string): string {
  return `Saved. ${clientName} uses the new access from its next request, with no need to reconnect.`;
}
