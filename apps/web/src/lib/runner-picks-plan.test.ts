import { describe, expect, it } from 'bun:test';
import type { ConsentTeam } from './oauth/account-consent';
import { checkPicks, chooseHomeTeam, levelForPicks, runnerPickerTeams, teamsOfPicks } from './runner-picks-plan';

const teams: ConsentTeam[] = [
  {
    id: 'team-a', name: 'Alpha', role: 'owner',
    workspaces: [
      { id: 'a-open', name: 'a-open', accessMode: 'open' },
      { id: 'a-restricted', name: 'a-restricted', accessMode: 'restricted' },
      { id: 'a-system', name: '__coordination', system: true, accessMode: 'open' },
    ],
  },
  {
    id: 'team-b', name: 'Beta', role: 'member',
    workspaces: [
      { id: 'b-open', name: 'b-open', accessMode: 'open' },
      { id: 'b-restricted', name: 'b-restricted', accessMode: 'restricted' },
    ],
  },
  { id: 'team-c', name: 'Gamma', role: 'member', workspaces: [{ id: 'c-restricted', name: 'c', accessMode: 'restricted' }] },
];

describe('runnerPickerTeams (R-2)', () => {
  const offered = runnerPickerTeams(teams);
  const ids = (id: string) => offered.find((t) => t.id === id)?.workspaces.map((w) => w.id);

  it("offers a team's restricted workspaces only to its owners and admins", () => {
    expect(ids('team-a')).toEqual(['a-open', 'a-restricted']);
    expect(ids('team-b')).toEqual(['b-open']);
  });

  it('leaves internal workspaces out and drops a team left with nothing', () => {
    expect(ids('team-a')).not.toContain('a-system');
    expect(offered.map((t) => t.id)).toEqual(['team-a', 'team-b']);
  });
});

describe('chooseHomeTeam', () => {
  it("is the person's default team when it holds a pick", () => {
    expect(chooseHomeTeam(teams, ['a-open', 'b-open'], 'team-b')?.id).toBe('team-b');
  });
  it('else the first picked team on the page', () => {
    expect(chooseHomeTeam(teams, ['b-open', 'a-open'], 'team-c')?.id).toBe('team-a');
    expect(chooseHomeTeam(teams, ['b-open'], null)?.id).toBe('team-b');
  });
  it('is null with no picks', () => {
    expect(chooseHomeTeam(teams, [], 'team-a')).toBeNull();
  });
});

describe('levelForPicks (R-2)', () => {
  it('keeps admin when the person is owner or admin in every picked team', () => {
    expect(levelForPicks('admin', teamsOfPicks(teams, ['a-open', 'a-restricted']))).toBe('admin');
  });
  it('caps at worker when any picked team has the person as a member', () => {
    expect(levelForPicks('admin', teamsOfPicks(teams, ['a-open', 'b-open']))).toBe('worker');
  });
  it('never raises a lower request', () => {
    expect(levelForPicks('trigger', teamsOfPicks(teams, ['a-open']))).toBe('trigger');
  });
});

describe('checkPicks', () => {
  const offered = runnerPickerTeams(teams);
  it('accepts offered ids, de-duplicated', () => {
    expect(checkPicks(offered, ['a-open', 'a-open', 'b-open'])).toEqual({ ok: true, workspaceIds: ['a-open', 'b-open'] });
  });
  it('refuses the whole list when one id is not offered, naming none', () => {
    const r = checkPicks(offered, ['a-open', 'b-restricted']);
    expect(r).toMatchObject({ ok: false, status: 403 });
    if (!r.ok) expect(r.message).not.toContain('b-restricted');
  });
  it('refuses an empty or malformed list', () => {
    expect(checkPicks(offered, [])).toMatchObject({ ok: false, status: 400 });
    expect(checkPicks(offered, 'a-open')).toMatchObject({ ok: false, status: 400 });
    expect(checkPicks(offered, [1])).toMatchObject({ ok: false, status: 400 });
  });
});
