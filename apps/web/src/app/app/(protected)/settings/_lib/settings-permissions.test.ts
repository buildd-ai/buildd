import { describe, expect, it } from 'bun:test';
import { PERMISSIONS, roleHas, type Permission } from '@/lib/permission-registry';
import { NO_PERMISSIONS, permsInAnyTeam, settingsPermissions, teamIdsHolding } from './settings-permissions';

const ALL = Object.keys(PERMISSIONS) as Permission[];
const team = (role: string, slug = 'acme') => ({ role, slug });

describe('settingsPermissions: one flag per permission, the server rule', () => {
  it('matches roleHas for every permission and role', () => {
    for (const role of ['owner', 'admin', 'member', 'nonsense']) {
      const flags = settingsPermissions(team(role), 'user-1');
      for (const p of ALL) expect([role, p, flags[p]]).toEqual([role, p, roleHas(role, p)]);
    }
  });

  it('a member does not manage billing', () => {
    const flags = settingsPermissions(team('member'), 'user-1');
    expect(flags.manage_billing).toBe(false);
  });

  it('a personal team counts as owned, whatever the membership row says', () => {
    const flags = settingsPermissions(team('member', 'personal-user-1'), 'user-1');
    expect(ALL.every((p) => flags[p])).toBe(true);
    // Someone else's personal team is not yours.
    expect(settingsPermissions(team('member', 'personal-user-2'), 'user-1').create_workspace).toBe(false);
  });

  it('no team holds nothing', () => {
    expect(settingsPermissions(null, 'user-1')).toBe(NO_PERMISSIONS);
    expect(ALL.some((p) => NO_PERMISSIONS[p])).toBe(false);
  });
});

describe('teamIdsHolding', () => {
  it('lists the teams whose flags hold the permission', () => {
    const byTeam = {
      a: settingsPermissions(team('admin'), 'u'),
      b: settingsPermissions(team('member'), 'u'),
      c: settingsPermissions(team('owner'), 'u'),
    };
    expect(teamIdsHolding(byTeam, 'manage_connectors')).toEqual(['a', 'c']);
    expect(teamIdsHolding(byTeam, 'create_personal_roles')).toEqual(['a', 'b', 'c']);
  });
});

describe('permsInAnyTeam', () => {
  it('holds a permission held in any one team, and nothing with no teams', () => {
    const member = settingsPermissions({ role: 'member', slug: 'a' }, 'u');
    const admin = settingsPermissions({ role: 'admin', slug: 'b' }, 'u');
    expect(permsInAnyTeam({ a: member, b: admin }).create_workspace).toBe(true);
    expect(permsInAnyTeam({ a: member }).create_workspace).toBe(false);
    expect(permsInAnyTeam({ a: member }).create_personal_roles).toBe(true);
    expect(Object.values(permsInAnyTeam({})).some(Boolean)).toBe(false);
  });
});
