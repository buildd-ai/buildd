import { describe, expect, it } from 'bun:test';
import { byTeam, connectionMeta, lastActive, selectionChange } from './connections-view';

const NOW = new Date('2026-10-09T12:00:00Z');
const ws = (id: string, teamId: string) => ({ id, name: id, teamId, teamName: teamId.toUpperCase() });

describe('lastActive', () => {
  it('is coarse: hour, hours, yesterday, days', () => {
    expect(lastActive(null, NOW)).toBe('not used since it was connected');
    expect(lastActive('2026-10-09T11:30:00Z', NOW)).toBe('active in the last hour');
    expect(lastActive('2026-10-09T09:00:00Z', NOW)).toBe('active 3 hours ago');
    expect(lastActive('2026-10-09T11:00:00Z', NOW)).toBe('active 1 hour ago');
    expect(lastActive('2026-10-08T10:00:00Z', NOW)).toBe('active yesterday');
    expect(lastActive('2026-09-27T12:00:00Z', NOW)).toBe('active 12 days ago');
  });
});

describe('connectionMeta', () => {
  it('counts workspaces, says the access in words, and when it was last active', () => {
    expect(connectionMeta({ workspaces: [ws('a', 't')], access: 'read', lastActiveAt: null }, NOW))
      .toBe('1 workspace · read only · not used since it was connected');
    expect(connectionMeta({ workspaces: [ws('a', 't'), ws('b', 't')], access: 'read-write', lastActiveAt: '2026-10-09T09:00:00Z' }, NOW))
      .toBe('2 workspaces · read and write · active 3 hours ago');
  });
});

describe('selectionChange', () => {
  it('turns a selection into adds and removes against what the connection reaches', () => {
    expect(selectionChange(['a', 'b'], ['b', 'c', 'd'])).toEqual({ add: ['c', 'd'], remove: ['a'] });
    expect(selectionChange(['a'], ['a'])).toEqual({ add: [], remove: [] });
  });
});

describe('byTeam', () => {
  it('groups in order, one group per team', () => {
    const g = byTeam([ws('a', 't1'), ws('b', 't1'), ws('c', 't2')]);
    expect(g.map((x) => [x.teamName, x.workspaces.map((w) => w.id)])).toEqual([['T1', ['a', 'b']], ['T2', ['c']]]);
  });
});

describe('team access review', () => {
  const { reviewTeamEdit, reachSummary, initialTeamSelection, editableWorkspaces } = require('./connections-view') as typeof import('./connections-view');
  const team = { id: 't1', name: 'Platform', role: 'owner', workspaces: [
    { id: 'c', name: '__coordination', system: true }, { id: 'a', name: 'api' }, { id: 'b', name: 'web' }, { id: 'd', name: 'docs' },
  ] };
  const base = { clientName: 'App', access: 'read' as const, actsAs: 'agent' as const };
  const specific = { ...base, workspaces: [ws('a', 't1'), ws('x', 't2')], teams: [
    { teamId: 't1', teamName: 'Platform', mode: 'specific' as const, workspaces: [ws('a', 't1')] },
    { teamId: 't2', teamName: 'Other', mode: 'specific' as const, workspaces: [ws('x', 't2')] },
  ] };
  const whole = { ...base, workspaces: [ws('a', 't1'), ws('b', 't1'), ws('d', 't1')], teams: [
    { teamId: 't1', teamName: 'Platform', mode: 'all' as const, workspaces: [ws('a', 't1'), ws('b', 't1'), ws('d', 't1')] },
  ] };

  it('all workspaces widens and says what it inherits; internal workspaces are not counted', () => {
    const r = reviewTeamEdit({ connection: specific, team, choice: 'all', selected: [] });
    expect(r.change).toEqual({ teamId: 't1', mode: 'all' });
    expect(r.expands).toBe(true);
    expect(r.lines[0]).toBe('App gets every workspace in Platform: 3 workspaces now, 2 more than today, and any created in or moved into Platform later.');
    expect(r.lines[1]).toBe('They get the same access: read only, as your agent.');
  });
  it('from all, the editor starts with what it reaches now; keeping it all freezes exactly that and narrows', () => {
    const start = initialTeamSelection(whole, 't1');
    expect(start).toEqual(['a', 'b', 'd']);
    const r = reviewTeamEdit({ connection: whole, team, choice: 'specific', selected: start });
    expect(r.change).toEqual({ teamId: 't1', mode: 'specific', workspaceIds: ['a', 'b', 'd'] });
    expect(r.expands).toBe(false);
    expect(r.lines[0]).toContain('later are not included');
  });
  it('no change, an empty specific choice, and taking the last team away are not saveable', () => {
    expect(reviewTeamEdit({ connection: whole, team, choice: 'all', selected: [] }).change).toBeNull();
    expect(reviewTeamEdit({ connection: specific, team, choice: 'specific', selected: ['a'] }).change).toBeNull();
    expect(reviewTeamEdit({ connection: whole, team, choice: 'specific', selected: [] }).invalid).toContain('Tick at least one');
    expect(reviewTeamEdit({ connection: whole, team, choice: 'none', selected: [] }).invalid).toContain('Revoke it instead');
  });
  it('No access removes the team when another team keeps the connection useful', () => {
    const r = reviewTeamEdit({ connection: specific, team, choice: 'none', selected: [] });
    expect(r.change).toEqual({ teamId: 't1', mode: 'none' });
    expect(r.expands).toBe(false);
  });
  it('adding a workspace to a specific team is a widening; dropping one is not', () => {
    expect(reviewTeamEdit({ connection: specific, team, choice: 'specific', selected: ['a', 'b'] }).expands).toBe(true);
    const shrink = reviewTeamEdit({ connection: { ...specific, teams: [{ ...specific.teams[0], workspaces: [ws('a', 't1'), ws('b', 't1')] }, specific.teams[1]] }, team, choice: 'specific', selected: ['a'] });
    expect(shrink.expands).toBe(false);
    expect(shrink.lines).toEqual(['Removes 1 workspace in Platform.']);
  });
  it('offers internal workspaces only when the connection already has one', () => {
    expect(editableWorkspaces(team, []).workspaces.map((w) => w.id)).toEqual(['a', 'b', 'd']);
    expect(editableWorkspaces(team, ['c']).workspaces.map((w) => w.id)).toEqual(['c', 'a', 'b', 'd']);
  });
  it('reach never reads as a fixed count when a team is on all workspaces', () => {
    expect(reachSummary(specific)).toBe('2 workspaces');
    expect(reachSummary(whole)).toBe('3 workspaces now, plus new ones in 1 team');
  });
});
