import { describe, expect, it } from 'bun:test';
import { PERMISSIONS, roleHas, type Permission } from '@/lib/permission-registry';
import { NO_PERMISSIONS, settingsPermissions, teamIdsHolding } from './settings-permissions';

const ALL = Object.keys(PERMISSIONS) as Permission[];
const team = (role: string, slug = 'acme') => ({ role, slug });

describe('settingsPermissions: one flag per permission, the server rule', () => {
  it('matches roleHas for every permission, role and override set', () => {
    const overrides = { manage_connectors: ['owner', 'admin', 'member'] as const, manage_workspace_settings: ['owner'] as const };
    for (const role of ['owner', 'admin', 'member', 'nonsense']) {
      for (const o of [null, {}, overrides]) {
        const flags = settingsPermissions(team(role), 'user-1', o);
        for (const p of ALL) expect([role, p, flags[p]]).toEqual([role, p, roleHas(role, p, o)]);
      }
    }
  });

  it('member: only personal roles by default, plus exactly what an override grants', () => {
    const base = settingsPermissions(team('member'), 'user-1', {});
    expect(ALL.filter((p) => base[p])).toEqual(['create_personal_roles']);
    const granted = settingsPermissions(team('member'), 'user-1', { create_workspace: ['owner', 'admin', 'member'] });
    expect(ALL.filter((p) => granted[p]).sort()).toEqual(['create_personal_roles', 'create_workspace']);
  });

  it('admin: loses a permission an override narrows to owners', () => {
    const flags = settingsPermissions(team('admin'), 'user-1', { manage_team_credentials: ['owner'] });
    expect(flags.manage_team_credentials).toBe(false);
    expect(flags.manage_inference_providers).toBe(true);
  });

  it('a locked permission ignores overrides', () => {
    const flags = settingsPermissions(team('member'), 'user-1', { manage_billing: ['owner', 'admin', 'member'] } as never);
    expect(flags.manage_billing).toBe(false);
  });

  it('a personal team counts as owned, whatever the membership row says', () => {
    const flags = settingsPermissions(team('member', 'personal-user-1'), 'user-1', {});
    expect(ALL.every((p) => flags[p])).toBe(true);
    // Someone else's personal team is not yours.
    expect(settingsPermissions(team('member', 'personal-user-2'), 'user-1', {}).create_workspace).toBe(false);
  });

  it('no team holds nothing', () => {
    expect(settingsPermissions(null, 'user-1', {})).toBe(NO_PERMISSIONS);
    expect(ALL.some((p) => NO_PERMISSIONS[p])).toBe(false);
  });
});

describe('teamIdsHolding', () => {
  it('lists the teams whose flags hold the permission', () => {
    const byTeam = {
      a: settingsPermissions(team('admin'), 'u', {}),
      b: settingsPermissions(team('member'), 'u', {}),
      c: settingsPermissions(team('member'), 'u', { manage_connectors: ['owner', 'admin', 'member'] }),
    };
    expect(teamIdsHolding(byTeam, 'manage_connectors')).toEqual(['a', 'c']);
    expect(teamIdsHolding(byTeam, 'create_workspace')).toEqual(['a']);
  });
});
