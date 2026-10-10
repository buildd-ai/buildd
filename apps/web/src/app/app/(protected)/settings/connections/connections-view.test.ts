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
