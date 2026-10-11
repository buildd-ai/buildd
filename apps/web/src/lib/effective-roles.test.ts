import { describe, it, expect, mock } from 'bun:test';

// pickEffectiveRole reads the workspace's team and its role rows.
let workspaceRow: { teamId: string } | null = { teamId: 'team-1' };
let roleRows: Array<RoleScopeRow> = [];
let lookupThrows = false;
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: async () => workspaceRow },
      workspaceSkills: {
        findMany: async () => {
          if (lookupThrows) throw new Error('db down');
          return roleRows;
        },
      },
    },
  },
}));

import { effectiveRoleSlugs, pickEffectiveRole, type RoleScopeRow } from './effective-roles';

const CTX = { teamId: 'team-1', workspaceId: 'ws-1', requesterUserId: null };

describe('effectiveRoleSlugs (role-routing §3.1)', () => {
  it('includes enabled team defaults and workspace overrides', () => {
    const slugs = effectiveRoleSlugs([
      { slug: 'builder', workspaceId: null, teamId: 'team-1', ownerUserId: null, visibility: 'team', enabled: true },
      { slug: 'ops', workspaceId: 'ws-1', teamId: 'team-1', ownerUserId: null, visibility: 'team', enabled: true },
    ], CTX);
    expect([...slugs].sort()).toEqual(['builder', 'ops']);
  });

  it('lets a workspace override that disables a role win over the enabled team default', () => {
    for (const rows of [
      [{ slug: 'builder', workspaceId: null, teamId: 'team-1', ownerUserId: null, visibility: 'team', enabled: true }, { slug: 'builder', workspaceId: 'ws-1', teamId: 'team-1', ownerUserId: null, visibility: 'team', enabled: false }],
      [{ slug: 'builder', workspaceId: 'ws-1', teamId: 'team-1', ownerUserId: null, visibility: 'team', enabled: false }, { slug: 'builder', workspaceId: null, teamId: 'team-1', ownerUserId: null, visibility: 'team', enabled: true }],
    ]) {
      expect(effectiveRoleSlugs(rows, CTX).has('builder')).toBe(false);
    }
  });

  it('lets an enabled override revive a disabled team default', () => {
    const slugs = effectiveRoleSlugs([
      { slug: 'writer', workspaceId: null, teamId: 'team-1', ownerUserId: null, visibility: 'team', enabled: false },
      { slug: 'writer', workspaceId: 'ws-1', teamId: 'team-1', ownerUserId: null, visibility: 'team', enabled: true },
    ], CTX);
    expect(slugs.has('writer')).toBe(true);
  });

  it("includes the requester's own and shared personal roles, never another member's private one", () => {
    const personal = (slug: string, ownerUserId: string, visibility: string) =>
      ({ slug, workspaceId: null, teamId: 'team-1', ownerUserId, visibility, enabled: true });
    const rows = [personal('alices', 'u-alice', 'private'), personal('bobs', 'u-bob', 'private'), personal('shared', 'u-bob', 'team')];
    expect([...effectiveRoleSlugs(rows, { ...CTX, requesterUserId: 'u-alice' })].sort()).toEqual(['alices', 'shared']);
    expect([...effectiveRoleSlugs(rows, CTX)]).toEqual(['shared']);
  });

  it('is empty when the workspace has no role rows', () => {
    expect(effectiveRoleSlugs([], CTX).size).toBe(0);
  });
});

describe('pickEffectiveRole (role-routing §1 row 9)', () => {
  function given(rows: typeof roleRows) {
    workspaceRow = { teamId: 'team-1' };
    roleRows = rows;
    lookupThrows = false;
  }

  it('returns the first candidate the workspace resolves, skipping blanks', async () => {
    given([{ slug: 'builder', workspaceId: null, teamId: 'team-1', ownerUserId: null, visibility: 'team', enabled: true }, { slug: 'writer', workspaceId: null, teamId: 'team-1', ownerUserId: null, visibility: 'team', enabled: true }]);
    expect(await pickEffectiveRole('ws-1', [null, '', 'writer', 'builder'])).toBe('writer');
  });

  it('falls through a pass-through slug the workspace lacks to the constant', async () => {
    given([{ slug: 'builder', workspaceId: null, teamId: 'team-1', ownerUserId: null, visibility: 'team', enabled: true }]);
    expect(await pickEffectiveRole('ws-1', ['ops', 'builder'])).toBe('builder');
  });

  it('is null when no candidate resolves — never a slug the claim filter would strand', async () => {
    given([{ slug: 'builder', workspaceId: 'ws-1', teamId: 'team-1', ownerUserId: null, visibility: 'team', enabled: false }]);
    expect(await pickEffectiveRole('ws-1', ['builder', 'researcher'])).toBeNull();
  });

  it('is null when the workspace is unknown or the lookup throws', async () => {
    given([{ slug: 'builder', workspaceId: null, teamId: 'team-1', ownerUserId: null, visibility: 'team', enabled: true }]);
    workspaceRow = null;
    expect(await pickEffectiveRole('ws-1', ['builder'])).toBeNull();
    given([]);
    lookupThrows = true;
    expect(await pickEffectiveRole('ws-1', ['builder'])).toBeNull();
  });
});
